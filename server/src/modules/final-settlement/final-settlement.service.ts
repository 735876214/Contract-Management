import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num, assertVersion } from '../../common/utils/helpers';
import { round2 } from '../../common/utils/money';
import { pickFields } from '../../common/pick-fields';
import { DictService } from '../dict/dict.service';
import { ContractService } from '../contract/contract.service';
import { ContractLockService } from '../../common/services/contract-lock.service';
import { requestContext } from '../../common/services/request-context';
import { DocTemplateService } from '../doc-template/doc-template.service';
import { monthKey } from '../../common/utils/settlement-period';
import { CONTRACT_EXECUTION_STATUS, FINAL_SETTLEMENT_STATUS } from '../../constants/statuses';
import {
  buildFinalSettlementDocValues,
} from './final-settlement-vars';

const FIELDS = ['remark'];

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
        orderBy: { createdAt: 'desc' },
        include: {
          contract: { select: { id: true, code: true, name: true, execStatus: true } },
          items: { orderBy: { sortOrder: 'asc' } },
        },
      }),
      this.prisma.finalSettlement.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async findOne(id: string) {
    // 项目隔离（第 3 轮审计）：按 id 直达的读/改/删/导出/传附件都走这里，统一带 projectId
    const projectId = requestContext.projectId;
    const row = await this.prisma.finalSettlement.findFirst({
      where: { id, ...(projectId ? { projectId } : {}) },
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
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
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
      where: { contractId, NOT: { statusCode: 'DRAFT' } },
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

  async update(id: string, data: any) {
    const before: any = await this.findOne(id);
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
  async attach(id: string, file: { url: string; fileName: string }, user?: any) {
    const before: any = await this.findOne(id);
    await this.lock.assertWritable(before.contractId, '上传总结算单附件');
    if (!file?.url) throw new BadRequestException('缺少附件');
    await this.dict.validate('contract_execution_status', CONTRACT_EXECUTION_STATUS.DONE_SETTLED);

    const updated = await this.prisma.finalSettlement.update({
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

    await this.prisma.contract.update({
      where: { id: before.contractId },
      data: { execStatus: CONTRACT_EXECUTION_STATUS.DONE_SETTLED, version: { increment: 1 } },
    });
    // 合同执行情况变了 → 重算「当前生效比例」（已完已结 = 100%），台账列与付款预警读的就是它
    await this.contract.syncPayRatio(before.contractId);
    return updated;
  }

  async remove(id: string) {
    const before: any = await this.findOne(id);
    await this.lock.assertWritable(before.contractId, '删除总结算单');
    await this.prisma.finalSettlement.delete({ where: { id } });
    // 已结算的单据被删 → 合同不再处于"已完已结"（否则会留下没有单据支撑的假状态）
    if (before.statusCode === FINAL_SETTLEMENT_STATUS.SETTLED) {
      const contract = await this.prisma.contract.findUnique({
        where: { id: before.contractId },
        select: { execStatus: true },
      });
      if (contract?.execStatus === CONTRACT_EXECUTION_STATUS.DONE_SETTLED) {
        await this.prisma.contract.update({
          where: { id: before.contractId },
          data: { execStatus: CONTRACT_EXECUTION_STATUS.DONE_UNSETTLED, version: { increment: 1 } },
        });
        await this.contract.syncPayRatio(before.contractId);
      }
    }
    return true;
  }

  /** 导出总结算单 Word（模板分类 `FINAL_SETTLEMENT`；明细表走 `{{结算明细表}}` 表格占位符） */
  async export(id: string, templateId?: string) {
    const doc: any = await this.findOne(id);
    const [contract, project] = await Promise.all([
      this.prisma.contract.findUnique({
        where: { id: doc.contractId },
        select: { id: true, code: true, name: true, supplierId: true },
      }),
      this.prisma.project.findUnique({
        where: { id: doc.projectId },
        select: { name: true, nameAbbr: true, code: true },
      }),
    ]);
    const supplier = contract?.supplierId
      ? await this.prisma.supplier.findUnique({ where: { id: contract.supplierId }, select: { name: true } })
      : null;

    const values = buildFinalSettlementDocValues({ doc, contract, supplier, project });
    // 业务 2026-10-17：总结算单生成路径 Word → Excel（模板为上传的 xlsx，明细占位符整格多行）
    return this.docTemplate.renderFinalSettlement({
      doc,
      contract,
      project,
      supplier,
      values,
      templateId,
      filename: `${doc.code || '总结算单'}.xlsx`,
    });
  }
}
