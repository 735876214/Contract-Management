import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { num } from '../../common/calc/numeric';
import { localDayKey } from '../../common/calc/time';
import { paginate, buildResult, assertVersion } from '../../common/utils/helpers';
import { notDraft } from '../../common/utils/contract-chain';
import { round2 } from '../../common/calc/money';
import { pickFields } from '../../common/pick-fields';
import { DictService } from '../dict';
import { ContractService, setContractExecStatus } from '../contract';
import { ContractLockService } from '../../common/services/contract-lock.service';
import { requestContext } from '../../common/services/request-context';
import { DocTemplateService } from '../doc-template';
import { monthKey } from '../../common/utils/settlement-period';
import { CONTRACT_EXECUTION_STATUS, FINAL_SETTLEMENT_STATUS } from '../../constants/statuses';
import { renderFinalSettlementXlsx } from './final-settlement-excel';

const FIELDS = ['remark', 'reduceAmount'];

/**
 * **总结算单**（业务口径 2026-10-16）：结算及付款管理下的单据。
 *
 * 生命周期：
 * ① **生成**：抓取该合同**全部月度结算**（月份 + 实结金额）落成明细**快照**，`totalAmount` = 明细合计；
 * ② **上传附件** → 状态置「已结算」 → 合同 `execStatus` 置 `DONE_SETTLED`（已完已结）
 *    → 付款比例随之切到 **100%**（走 `contract.service.syncPayRatio`，台账/预警读的就是它）；
 * ③ 删除**已结算**的总结算单 → 合同执行情况**回退**到 `DONE_UNSETTLED`（否则会留下"没有任何单据
 *    却显示已完已结"的假状态）。
 *
 * ⚠️ 一个合同只允许一张总结算单（重复生成 → 400）：它是"这单合同的月度结算都结完了"的收口凭证。
 * ⚠️ 明细是快照：月度结算事后被改，不回头改已出的总结算单（与付款手续的"开累"同理）。
 */
@Injectable()
export class FinalSettlementService {
  constructor(
    private prisma: PrismaClient,
    private dict: DictService,
    private contract: ContractService,
    private docTemplate: DocTemplateService,
    private lock: ContractLockService,
  ) {}

  async findAll(query: any = {}, projectId: string) {
    const { skip, take } = paginate(query);
    const where: any = { projectId };
    if (query.contractId) where.contractId = query.contractId;
    if (query.statusCode) where.statusCode = query.statusCode;
    if (query.keyword) {
      where.OR = [
        { code: { contains: query.keyword } },
        { contract: { name: { contains: query.keyword } } },
      ];
    }
    const [list, total] = await Promise.all([
      this.prisma.finalSettlement.findMany({
        where,
        skip,
        take,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          contract: { select: { id: true, code: true, name: true, execStatus: true } },
          items: { orderBy: { sortOrder: 'asc' } },
        },
      }),
      this.prisma.finalSettlement.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  /**
   * 按 id 取单据：必须带项目隔离（结算模块审计 P1-2）。
   * projectId 由 controller 的 @ProjectId() 显式传入；内部调用未传时回退请求上下文，
   * 但两者都没有就拒绝读取——绝不允许退化成「只按 id」的跨项目直达。
   */
  async findOne(id: string, projectId?: string) {
    const pid = projectId ?? requestContext.projectId;
    if (!pid) throw new BadRequestException('缺少项目上下文（x-project-id），请刷新页面或重新登录选择项目');
    const row = await this.prisma.finalSettlement.findFirst({
      where: { id, projectId: pid },
      include: {
        contract: { select: { id: true, code: true, name: true, execStatus: true } },
        items: { orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!row) throw new NotFoundException('总结算单不存在');
    return row;
  }

  /** 单据编号：`ZJS-<合同编号>-<日期>`，同项目已存在则追加序号 */
  private async nextCode(projectId: string, contractCode: string) {
    const day = localDayKey().replace(/-/g, '');
    const base = `ZJS-${contractCode}-${day}`;
    for (let i = 0; i < 20; i += 1) {
      const code = i === 0 ? base : `${base}-${i + 1}`;
      const dup = await this.prisma.finalSettlement.findFirst({ where: { projectId, code }, select: { id: true } });
      if (!dup) return code;
    }
    throw new BadRequestException('总结算单编号生成失败，请重试');
  }

  /**
   * 生成总结算单：抓该合同**全部非草稿**月度结算（与链口径一致：草稿不算已发生结算），
   * 逐月落成明细快照，`totalAmount` = 明细合计。
   *
   * 没有任何月度结算 → 400（没有可总结算的内容，不该产出一张空单据）。
   */
  async generate(contractId: string, projectId: string, user?: any) {
    if (!contractId) throw new BadRequestException('请选择合同');
    await this.lock.assertWritable(contractId, '生成总结算单');
    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
      select: { id: true, code: true, projectId: true },
    });
    if (!contract || contract.projectId !== projectId) throw new BadRequestException('合同不存在或不属于当前项目');

    const exist = await this.prisma.finalSettlement.findFirst({ where: { projectId, contractId }, select: { id: true, code: true } });
    if (exist) {
      throw new BadRequestException(
        `该合同已有总结算单${exist.code ? `（${exist.code}）` : ''}：一个合同只允许一张总结算单。`,
      );
    }

    const settlements: any[] = await this.prisma.settlement.findMany({
      /**
       * 用 `notDraft` 而不是 `NOT: { statusCode: 'DRAFT' }`（第 21 轮审计 P1）：
       * `Settlement.statusCode` 是 **String?**，SQL 里 `NOT (statusCode = 'DRAFT')` 对 NULL 求值为
       * **UNKNOWN**，NULL 状态的历史结算单会被整批漏掉 → 总结算单金额偏小（付款比例跟着按小额算）。
       * `notDraft` 是 `OR [{null}, {not:'DRAFT'}]`，把 NULL 当「非草稿」纳入，与台账口径一致。
       */
      where: { contractId, ...notDraft },
      select: { id: true, settleDate: true, amount: true, actualAmount: true },
      orderBy: { settleDate: 'asc' },
    });
    if (!settlements.length) {
      throw new BadRequestException('该合同没有（非草稿的）月度结算，无法生成总结算单：请先办理月度结算。');
    }

    const items = settlements.map((s, i) => ({
      settleMonth: monthKey(s.settleDate) || '',
      amount: round2(num(s.actualAmount ?? s.amount) || 0),
      settlementId: s.id,
      sortOrder: i + 1,
    }));
    const totalAmount = round2(items.reduce((t, i) => t + (Number(i.amount) || 0), 0));

    try {
      return await this.prisma.finalSettlement.create({
        data: {
          projectId,
          contractId,
          code: await this.nextCode(projectId, contract.code),
          statusCode: FINAL_SETTLEMENT_STATUS.PENDING_ATTACHMENT,
          totalAmount,
          createdBy: user?.userId || user?.id || null,
          items: { create: items },
        },
        include: { items: { orderBy: { sortOrder: 'asc' } } },
      });
    } catch (e: any) {
      // 双击/并发下可能同时通过「不存在」预检再撞唯一约束：转 400 提示重试，而非 500。
      if (e?.code === 'P2002') throw new BadRequestException('总结算单已生成（可能并发生成），请刷新后查看');
      throw e;
    }
  }

  async update(id: string, data: any, projectId?: string) {
    const before: any = await this.findOne(id, projectId);
    assertVersion(before, data);
    await this.lock.assertWritable(before.contractId, '修改总结算单');
    const payload: any = pickFields(data, FIELDS, { label: '总结算单' });
    delete payload.version;
    // 状态只经受控动作（上传附件）变更，不从这里直传 —— 否则"已结算"会绕过合同状态联动
    return this.prisma.finalSettlement.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });
  }

  /**
   * **上传附件 → 已结算**（业务口径 2026-10-16 的收口动作）：
   * 写入附件（键由前端经 `POST /files/upload` 落盘后传回，落盘唯一入口是 `StorageService`）
   * → 状态 `SETTLED` + `settledAt` → 合同 `execStatus = DONE_SETTLED` → 重算付款比例（→ 100%）。
   */
  async attach(id: string, file: { url: string; fileName: string }, user?: any, projectId?: string) {
    const before: any = await this.findOne(id, projectId);
    await this.lock.assertWritable(before.contractId, '上传总结算单附件');
    if (!file?.url) throw new BadRequestException('缺少附件');
    await this.dict.validate('contract_execution_status', CONTRACT_EXECUTION_STATUS.DONE_SETTLED);

    // 「单据置已结算」与「合同置已完已结」是同一笔业务事实，必须在同一事务里落库：
    // 只成功一半会留下「单据已结算、合同仍显示未结」的假状态（付款比例也跟着错）。
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.finalSettlement.update({
        where: { id },
        data: {
          attachmentUrl: file.url,
          attachmentName: file.fileName,
          statusCode: FINAL_SETTLEMENT_STATUS.SETTLED,
          settledAt: before.settledAt ?? new Date(),
          version: { increment: 1 },
        },
        include: { items: { orderBy: { sortOrder: 'asc' } } },
      });

      // 合同行归 contract 模块所有：走对方的写入原语，不在这里直接写表
      await setContractExecStatus(tx, before.contractId, CONTRACT_EXECUTION_STATUS.DONE_SETTLED);
      return row;
    });
    // 合同执行情况变了 → 重算「当前生效比例」（已完已结 = 100%），台账列与付款预警读的就是它
    await this.contract.syncPayRatio(before.contractId);
    return updated;
  }

  async remove(id: string, projectId?: string) {
    const before: any = await this.findOne(id, projectId);
    await this.lock.assertWritable(before.contractId, '删除总结算单');
    // 「删单据」与「合同执行情况回退」同一事务：只删成功而回退失败会留下
    // 「没有任何单据却显示已完已结」的假状态（付款比例卡在 100%）。
    const rolledBack = await this.prisma.$transaction(async (tx) => {
      await tx.finalSettlement.delete({ where: { id } });
      if (before.statusCode !== FINAL_SETTLEMENT_STATUS.SETTLED) return false;
      const contract = await tx.contract.findUnique({
        where: { id: before.contractId },
        select: { execStatus: true },
      });
      if (contract?.execStatus !== CONTRACT_EXECUTION_STATUS.DONE_SETTLED) return false;
      await setContractExecStatus(tx, before.contractId, CONTRACT_EXECUTION_STATUS.DONE_UNSETTLED);
      return true;
    });
    if (rolledBack) await this.contract.syncPayRatio(before.contractId);
    return true;
  }

  /**
   * 编辑明细（月份/金额）+ 审减金额，保存即重算合计（`totalAmount` = 明细合计）。
   *
   * 业务口径（2026-11）：生成后允许经办人按实际调整每期月份与金额、并手工录入审减金额，
   * 保存即生效——不再需要"先手工维护单据模板"才能出正确结算书。
   * ⚠️ 只有「待上传附件」(`PENDING_ATTACHMENT`) 状态可编辑：一旦上传附件（已结算、合同已完已结、
   *    付款比例已切 100%），明细/金额即为已确认快照，不再允许改动。
   */
  async updateItems(
    id: string,
    body: { items?: Array<{ id?: string; settleMonth?: string; amount?: any }>; reduceAmount?: any; version?: number },
    projectId?: string,
  ) {
    const before: any = await this.findOne(id, projectId);
    assertVersion(before, body);
    await this.lock.assertWritable(before.contractId, '编辑总结算单明细');
    if (before.statusCode !== FINAL_SETTLEMENT_STATUS.PENDING_ATTACHMENT) {
      throw new BadRequestException('总结算单已上传附件（已结算），明细不可再修改');
    }
    const incoming = Array.isArray(body.items) ? body.items : [];
    if (!incoming.length) throw new BadRequestException('至少保留一条结算明细');

    // 参数校验 + 规范化（月份 YYYY-MM；金额保留 2 位）
    const normalized = incoming.map((it, i) => {
      const month = String(it.settleMonth ?? '').trim();
      if (!/^\d{4}-\d{2}$/.test(month)) throw new BadRequestException(`第 ${i + 1} 行结算月份格式应为 YYYY-MM`);
      const amount = Number(it.amount);
      if (!Number.isFinite(amount)) throw new BadRequestException(`第 ${i + 1} 行结算金额无效`);
      return { id: it.id, settleMonth: month, amount: round2(amount), sortOrder: i + 1 };
    });

    const existing = new Map<string, any>((before.items || []).map((x: any) => [x.id, x]));
    const keepIds = new Set(normalized.filter((n) => n.id && existing.has(n.id)).map((n) => n.id as string));
    const totalAmount = round2(normalized.reduce((t, i) => t + (Number(i.amount) || 0), 0));
    const reduceAmount =
      body.reduceAmount === undefined || body.reduceAmount === null || body.reduceAmount === ''
        ? (before.reduceAmount ?? 0)
        : round2(Number(body.reduceAmount) || 0);

    return this.prisma.$transaction(async (tx) => {
      // 删除不在新列表中的旧明细
      const toDelete = [...existing.keys()].filter((eid) => !keepIds.has(eid));
      if (toDelete.length) await tx.finalSettlementItem.deleteMany({ where: { id: { in: toDelete } } });

      for (const it of normalized) {
        if (it.id && existing.has(it.id)) {
          await tx.finalSettlementItem.update({
            where: { id: it.id },
            data: { settleMonth: it.settleMonth, amount: it.amount, sortOrder: it.sortOrder },
          });
        } else {
          // 新增行：无 settlementId（人工补充的明细，非快照自月度结算）
          await tx.finalSettlementItem.create({
            data: {
              finalSettlementId: id,
              settleMonth: it.settleMonth,
              amount: it.amount,
              sortOrder: it.sortOrder,
            },
          });
        }
      }

      return tx.finalSettlement.update({
        where: { id },
        data: { totalAmount, reduceAmount, version: { increment: 1 } },
        include: { items: { orderBy: { sortOrder: 'asc' } } },
      });
    });
  }

  /**
   * 导出总结算书（《物资结算书》CSCEC-SW-B40806，5 个 sheet）。
   *
   * 业务口径 2026-11：不再依赖「单据模板」页手工上传的 xlsx（那套引擎只支持单表格占位符，产不出本合同
   * 要求的 5-sheet 版式），改用内置模板 `assets/final-settlement-template.xlsx` 直接渲染成品。
   */
  async export(id: string, doc?: any, projectId?: string) {
    const row: any = doc ?? (await this.findOne(id, projectId));
    const [contract, project] = await Promise.all([
      this.prisma.contract.findUnique({
        where: { id: row.contractId },
        select: { id: true, code: true, name: true, amount: true, supplierId: true },
      }),
      this.prisma.project.findUnique({
        where: { id: row.projectId },
        select: { name: true, nameAbbr: true, code: true, codeAbbr: true, branchCompanyAbbr: true },
      }),
    ]);
    const supplier = contract?.supplierId
      ? await this.prisma.supplier.findUnique({ where: { id: contract.supplierId }, select: { name: true } })
      : null;

    // 结算书编号：<分公司简称>-<项目编号>-WZZJS-<结算年份>-<流水号>
    // 分公司简称取项目「分公司简称」(branchCompanyAbbr)，未填回退 TMHB；项目编号取项目 codeAbbr（无则回退 code）
    const year = new Date(row.createdAt).getFullYear();
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const seq = await this.prisma.finalSettlement.count({
      where: { projectId: row.projectId, createdAt: { gte: yearStart, lte: new Date(row.createdAt) } },
    });
    const branchPrefix = project?.branchCompanyAbbr || 'TMHB';
    const projectCode = project?.codeAbbr || project?.code || '';
    const docNumber = `${branchPrefix}-${projectCode}-WZZJS-${year}-${String(seq).padStart(2, '0')}`;

    return renderFinalSettlementXlsx({
      doc: row,
      contract: contract ? { code: contract.code, name: contract.name, amount: contract.amount } : null,
      project,
      supplier,
      docNumber,
    });
  }
}
