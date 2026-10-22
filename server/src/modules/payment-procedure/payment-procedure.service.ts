import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num, toDate, assertVersion, localDayKey } from '../../common/utils/helpers';
import { round2 } from '../../common/utils/money';
import { pickFields } from '../../common/pick-fields';
import { DictService } from '../dict/dict.service';
import { requestContext } from '../../common/services/request-context';
import { TxClient } from '../../common/services/import-runner.service';
import { PAYMENT_EXCLUDED_STATUSES } from '../../constants/statuses';
// 开累两值的**同一实现**（与台账、防超付闸门、工作台预警共用）：不要在别处另算一遍
import { chainSettledTotal, chainPaidTotal } from '../../common/utils/contract-chain';

const FIELDS = ['projectId', 'supplierId', 'contractId', 'code', 'payDate', 'statusCode', 'remark'];

/**
 * **付款手续**（业务口径 2026-10-16）：付款管理下编制的付款单据，数据项是
 * 供应商名称 / **开累结算金额** / **开累付款金额** / 付款时间 / **未付款金额**。
 *
 * 两条刻意的设计：
 * - **「开累」两值是保存当时的快照**，由服务端按合同链口径算出（`chainSettledTotal` / `chainPaidTotal`），
 *   **不接受前端直传**。理由：单据是留痕，事后补录付款不该把已出的单据改写掉。
 *   口径与台账/预警同一实现（结算排除草稿、付款排除失败/退款），所以单据上的数字与台账能对上。
 * - **合同必填、供应商由合同带出**：付款手续是按**合同**出的（"开累结算/付款"本身是合同链口径）。
 *   若将来业务要"按供应商跨多个合同汇总出一张"，那是另一套归集规则（要定义多合同怎么合并），
 *   现在不猜。⚠️ 想改的话，改这一处 `resolveContractParties()` 即可。
 */
@Injectable()
export class PaymentProcedureService {
  constructor(
    private prisma: PrismaClient,
    private dict: DictService,
  ) {}

  async findAll(query: any = {}, projectId: string) {
    const { skip, take } = paginate(query);
    const where: any = { projectId };
    if (query.contractId) where.contractId = query.contractId;
    if (query.supplierId) where.supplierId = query.supplierId;
    if (query.statusCode) where.statusCode = query.statusCode;
    if (query.keyword) {
      where.OR = [
        { code: { contains: query.keyword } },
        { contract: { name: { contains: query.keyword } } },
        { supplier: { name: { contains: query.keyword } } },
      ];
    }
    if (query.startDate || query.endDate) {
      where.payDate = {};
      if (query.startDate) where.payDate.gte = new Date(query.startDate);
      if (query.endDate) where.payDate.lte = new Date(query.endDate);
    }
    const [list, total] = await Promise.all([
      this.prisma.paymentProcedure.findMany({
        where,
        skip,
        take,
        orderBy: [{ payDate: 'desc' }, { createdAt: 'desc' }],
        include: {
          supplier: { select: { id: true, name: true } },
          contract: { select: { id: true, code: true, name: true } },
        },
      }),
      this.prisma.paymentProcedure.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async findOne(id: string) {
    // 项目隔离（第 3 轮审计）：findUnique 只按 id，换个 id 就能读/改/删别的项目的付款手续。
    // projectId 取自请求上下文（x-project-id / ?projectId=）；无上下文（启动任务/单测）不追加过滤。
    const projectId = requestContext.projectId;
    const row = await this.prisma.paymentProcedure.findFirst({
      where: { id, ...(projectId ? { projectId } : {}) },
      include: {
        supplier: { select: { id: true, name: true } },
        contract: { select: { id: true, code: true, name: true } },
      },
    });
    if (!row) throw new NotFoundException('付款手续不存在');
    return row;
  }

  /**
   * 按合同取「供应商 + 开累结算 + 开累付款 + 未付款」——单据上的四个数字都出自这里。
   * 见类注释：合同必填、供应商由合同带出、开累口径与台账/闸门共用同一实现。
   */
  private async resolveContractAmounts(contractId: string) {
    const projectId = requestContext.projectId;
    const contract = await this.prisma.contract.findFirst({
      where: { id: contractId, ...(projectId ? { projectId } : {}) },
      select: { id: true, supplierId: true },
    });
    // 不属于当前项目与"不存在"同样处理，避免用枚举 id 探测别的项目有没有这份合同
    if (!contract) throw new BadRequestException('合同不存在或不属于当前项目');
    const [settled, paid] = await Promise.all([
      chainSettledTotal(this.prisma, contractId),
      chainPaidTotal(this.prisma, contractId, undefined, PAYMENT_EXCLUDED_STATUSES),
    ]);
    return {
      supplierId: contract.supplierId,
      settleCumAmount: round2(settled),
      paidCumAmount: round2(paid),
      unpaidAmount: round2(round2(settled) - round2(paid)),
    };
  }

  /** 单据编号：`FK-<合同编号>-<日期>`，同项目已存在则追加序号（表上有 `@@unique([projectId, code])`） */
  private async nextCode(projectId: string, contractId: string, payDate: Date | null) {
    const contract = await this.prisma.contract.findFirst({ where: { id: contractId, projectId }, select: { code: true } });
    const day = localDayKey(payDate ?? new Date()).replace(/-/g, '');
    const base = `FK-${contract?.code || 'HT'}-${day}`;
    for (let i = 0; i < 20; i += 1) {
      const code = i === 0 ? base : `${base}-${i + 1}`;
      const dup = await this.prisma.paymentProcedure.findFirst({ where: { projectId, code }, select: { id: true } });
      if (!dup) return code;
    }
    throw new BadRequestException('付款手续编号生成失败，请手动填写编号');
  }

  async create(data: any, projectId: string, user?: any, tx?: TxClient) {
    const db: any = tx || this.prisma;
    if (!data?.contractId) throw new BadRequestException('请选择合同（开累结算/付款是按合同链口径取的）');
    await this.dict.validate('payment_status', data.statusCode);
    const amounts = await this.resolveContractAmounts(data.contractId);
    const payDate = data.payDate ? toDate(data.payDate) : null;
    const code = data.code || (await this.nextCode(projectId, data.contractId, payDate));
    try {
      return await db.paymentProcedure.create({
      data: {
        ...pickFields(data, FIELDS, { label: '付款手续' }),
        projectId,
        code,
        payDate,
        // 开累两值与未付款额**一律服务端算**：前端传什么都不采信（见类注释）
        supplierId: amounts.supplierId,
        settleCumAmount: amounts.settleCumAmount,
        paidCumAmount: amounts.paidCumAmount,
        unpaidAmount: amounts.unpaidAmount,
        createdBy: user?.userId || user?.id || null,
        },
      });
    } catch (e: any) {
      // 编号生成是「先查后插」，并发下可能撞 @@unique([projectId, code])：
      // 转成 400 提示重试，而不是 500。
      if (e?.code === 'P2002') throw new BadRequestException('编号已被占用（可能并发生成），请重试');
      throw e;
    }
  }

  async update(id: string, data: any) {
    const before: any = await this.findOne(id);
    assertVersion(before, data);
    await this.dict.validate('payment_status', data.statusCode);
    const payload: any = pickFields(data, FIELDS, { label: '付款手续' });
    delete payload.version;
    delete payload.projectId;
    if (data.code) payload.code = data.code;
    if (data.payDate !== undefined) payload.payDate = data.payDate ? toDate(data.payDate) : null;
    /**
     * 换了合同 → 四个数字要按新合同重取（否则单据上的"开累"还是旧合同的）。
     * 没换合同 → **保持原快照不动**：这张单据上印的是编制当时的口径，事后补录付款不该改写它。
     * （要更新到最新口径，就在页面上"重新取数"另存一张，或由业务确认后手工改。）
     */
    if (payload.contractId && payload.contractId !== before.contractId) {
      const amounts = await this.resolveContractAmounts(payload.contractId);
      Object.assign(payload, amounts);
    }
    return this.prisma.paymentProcedure.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.paymentProcedure.delete({ where: { id } });
    return true;
  }
}
