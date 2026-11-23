import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { num } from '@cms/calc/numeric';
import { projectWhere } from '../../common/utils/project-scope';
import { calcPriceWithTax, calcTotalWithTax } from '@cms/calc/amounts';
import { ContractLockService } from '../../common/services/contract-lock.service';
import { DictService } from '../dict';

/**
 * 合同起草域（从 ContractService 拆出，P1-3 大服务拆分）。
 *
 * 覆盖两块强内聚、低耦合的子域：
 *  - 物料编码清单（Tab1，合同专属物资池）
 *  - 合同清单（Tab2，草稿明细，含合同税率同步）
 *
 * 设计约束：本服务**只依赖** prisma / 字典 / 归档锁，**不回调 ContractService**（避免循环依赖）。
 * ContractService 保留同名转发方法，控制器与 procurement-task 的调用点保持不变。
 */
@Injectable()
export class ContractDraftService {
  constructor(
    private prisma: PrismaClient,
    private dict: DictService,
    private lock: ContractLockService,
  ) {}

  /** 合同是否存在（用于起草子资源校验）；有请求上下文时同时校验项目归属 */
  private async assertContractExists(contractId: string) {
    const c = await this.prisma.contract.findFirst({ where: projectWhere(contractId) });
    if (!c) throw new NotFoundException('合同不存在');
    return c;
  }

  /** 归档后禁止写（与 ContractService 同义；起草子域独立一份，避免反向依赖） */
  private async assertNotArchived(id: string, action = '修改合同') {
    await this.lock.assertWritable(id, action);
  }

  // ==================== 合同起草：物料编码清单（Tab1，合同专属物资池） ====================

  /** 物料编码清单：物资名称/规格型号/MDM编码/DSC编码 */
  async poolList(contractId: string) {
    await this.assertContractExists(contractId);
    const rows = await this.prisma.contractMaterialPool.findMany({
      where: { contractId },
      orderBy: { sortOrder: 'asc' },
      include: { materialBase: true },
    });
    return rows.map((r) => ({
      id: r.id,
      materialBaseId: r.materialBaseId,
      sortOrder: r.sortOrder,
      name: r.materialBase.name,
      spec: r.materialBase.spec,
      mdmCode: r.materialBase.mdmCode,
      dscCode: r.materialBase.dscCode,
    }));
  }

  /** 从物资基础库批量导入（追加，已存在则跳过） */
  async poolAdd(contractId: string, materialIds: string[]) {
    await this.assertNotArchived(contractId, '修改合同物资清单');
    await this.assertContractExists(contractId);
    if (!Array.isArray(materialIds) || !materialIds.length) throw new BadRequestException('请选择要导入的物资');
    const bases = await this.prisma.materialBase.findMany({ where: { id: { in: materialIds }, status: 1 } });
    if (!bases.length) throw new BadRequestException('所选物资不存在或已停用');
    const existed = await this.prisma.contractMaterialPool.findMany({
      where: { contractId },
      select: { materialBaseId: true },
    });
    const has = new Set(existed.map((e) => e.materialBaseId));
    let maxSort = existed.length;
    let added = 0;
    for (const b of bases) {
      if (has.has(b.id)) continue;
      await this.prisma.contractMaterialPool.create({
        data: { contractId, materialBaseId: b.id, sortOrder: ++maxSort },
      });
      added += 1;
    }
    return { added, skipped: bases.length - added };
  }

  async poolRemove(contractId: string, poolId: string) {
    await this.assertNotArchived(contractId, '修改合同物资清单');
    await this.assertContractExists(contractId);
    const row = await this.prisma.contractMaterialPool.findFirst({ where: { id: poolId, contractId } });
    if (!row) throw new NotFoundException('物料不存在');
    await this.prisma.contractMaterialPool.delete({ where: { id: poolId } });
    // 需求修正1：Tab1（物料编码清单）与 Tab2（合同清单）独立维护，删除 Tab1 物料不再级联删除 Tab2 行
    return true;
  }

  // ==================== 合同起草：合同清单（Tab2，草稿明细） ====================

  /**
   * 合同级税率（需求修正2）：Tab2 合同清单物料税率统一来源于合同主表。
   * 全站税率单轨为百分数（13 = 13%），合同主表字段已改名 taxRatePct，无需再换算。
   */
  private async contractTaxPct(contractId: string): Promise<number | null> {
    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
      select: { taxRatePct: true },
    });
    return contract?.taxRatePct != null ? num(contract.taxRatePct) : null;
  }

  /** 合同税率变更后：Tab2 合同清单所有物料税率同步更新，并按税前单价/数量重算含税金额 */
  async syncDraftTaxFromContract(contractId: string) {
    const pct = await this.contractTaxPct(contractId);
    const rows = await this.prisma.contractDraftMaterial.findMany({ where: { contractId } });
    for (const r of rows) {
      const price = r.priceBeforeTax != null ? Number(r.priceBeforeTax) : null;
      const qty = r.qty != null ? Number(r.qty) : null;
      const priceWithTax = calcPriceWithTax(price, pct);
      const totalWithTax = calcTotalWithTax(priceWithTax, qty);
      await this.prisma.contractDraftMaterial.update({
        where: { id: r.id },
        data: { taxRatePct: pct, priceWithTax, totalWithTax },
      });
    }
  }

  /** 列表加载时按合同税率补齐物料税率并重算含税单价/暂定含税合价（持久化，保证展示与数据一致） */
  private async backfillDraftTax(contractId: string, rows: any[]) {
    const pct = await this.contractTaxPct(contractId);
    if (pct == null) return;
    for (const r of rows) {
      if (r.taxRatePct != null) continue;
      const tax = pct;
      const price = r.priceBeforeTax != null ? Number(r.priceBeforeTax) : null;
      const qty = r.qty != null ? Number(r.qty) : null;
      const priceWithTax = calcPriceWithTax(price, tax);
      const totalWithTax = calcTotalWithTax(priceWithTax, qty);
      await this.prisma.contractDraftMaterial.update({
        where: { id: r.id },
        data: { taxRatePct: tax, priceWithTax, totalWithTax },
      });
      r.taxRatePct = tax;
      r.priceWithTax = priceWithTax;
      r.totalWithTax = totalWithTax;
    }
  }

  /** 草稿清单行（含主数据字段与自动计算金额） */
  async draftList(contractId: string) {
    await this.assertContractExists(contractId);
    const rows = await this.prisma.contractDraftMaterial.findMany({
      where: { contractId },
      orderBy: { sortOrder: 'asc' },
      include: { materialBase: true },
    });
    await this.backfillDraftTax(contractId, rows as any[]);
    return rows.map((r) => ({
      id: r.id,
      materialBaseId: r.materialBaseId,
      seqNo: r.seqNo,
      name: r.materialBase.name,
      spec: r.materialBase.spec,
      unit: r.unit,
      qty: r.qty != null ? Number(r.qty) : null,
      priceBeforeTax: r.priceBeforeTax != null ? Number(r.priceBeforeTax) : null,
      taxRatePct: r.taxRatePct != null ? Number(r.taxRatePct) : null,
      priceWithTax: r.priceWithTax != null ? Number(r.priceWithTax) : null,
      totalWithTax: r.totalWithTax != null ? Number(r.totalWithTax) : null,
      remark: r.remark,
      sortOrder: r.sortOrder,
    }));
  }

  /** 从物料编码清单（Tab1）勾选派生到合同清单（Tab2），追加不覆盖 */
  async draftDerive(contractId: string, materialBaseIds: string[]) {
    await this.assertNotArchived(contractId, '修改合同清单');
    const contract = await this.assertContractExists(contractId);
    if (!Array.isArray(materialBaseIds) || !materialBaseIds.length) {
      throw new BadRequestException('请先在「物料编码清单」中勾选物资');
    }
    // 需求修正2：新增行预填合同税率（物料税率实时绑定合同税率，单轨百分数）
    const contractPct = contract.taxRatePct != null ? num(contract.taxRatePct) : null;
    const pool = await this.prisma.contractMaterialPool.findMany({
      where: { contractId, materialBaseId: { in: materialBaseIds } },
      orderBy: { sortOrder: 'asc' },
    });
    if (!pool.length) throw new BadRequestException('所选物资不在本合同的物料编码清单中');
    const existed = await this.prisma.contractDraftMaterial.findMany({
      where: { contractId },
      select: { materialBaseId: true, sortOrder: true },
    });
    const has = new Set(existed.map((e) => e.materialBaseId));
    let maxSort = existed.reduce((m, e) => Math.max(m, e.sortOrder || 0), 0);
    let added = 0;
    for (const p of pool) {
      if (has.has(p.materialBaseId)) continue;
      await this.prisma.contractDraftMaterial.create({
        data: {
          contractId,
          materialBaseId: p.materialBaseId,
          seqNo: ++maxSort,
          unit: '',
          taxRatePct: contractPct,
          sortOrder: maxSort,
          remark: '由物料编码清单派生',
        },
      });
      added += 1;
    }
    return { added, skipped: pool.length - added };
  }

  /**
   * 由「采购总清单」带入**起草期合同清单**（采购阶段已算过的量价不必在合同里重录）。
   *
   * 与 `draftDerive` 的区别：derive 取自本合同的「物料编码清单（物料池）」，
   * 本方法取自采购任务的 `ProcurementTotalItem`，用于**自动生成合同时**预填清单行。
   * - 税率与 `draftSave` 口径一致：一律取合同主表税率（物料税率不独立存储）；
   * - 含税单价 / 暂定含税合价按同一公式服务端重算（4 位精度），不信任调用方传入；
   * - 已存在的物资跳过（`@@unique([contractId, materialBaseId])`），可安全重复调用；
   * - 调用方需容错：带入失败不应阻断合同生成（见 procurement-task.service 的调用点）。
   *
   * @param items 采购总清单行（`materialBaseId` 必填；`priceBeforeTax` 约定传「控制价」planPrice）
   */
  async seedDraftFromProcurementItems(
    contractId: string,
    items: {
      materialBaseId?: string | null;
      qty?: number | null;
      priceBeforeTax?: number | null;
      unit?: string | null;
      remark?: string | null;
    }[],
  ): Promise<{ added: number; skipped: number }> {
    await this.assertContractExists(contractId);
    if (!Array.isArray(items) || !items.length) return { added: 0, skipped: 0 };
    const contractPct = await this.contractTaxPct(contractId);
    const existed = await this.prisma.contractDraftMaterial.findMany({
      where: { contractId },
      select: { materialBaseId: true, sortOrder: true },
    });
    const has = new Set(existed.map((e) => e.materialBaseId));
    let maxSort = existed.reduce((m, e) => Math.max(m, e.sortOrder || 0), 0);

    const numOf = (v: unknown): number | null => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    let added = 0;
    let skipped = 0;
    for (const it of items) {
      const materialBaseId = String(it?.materialBaseId ?? '').trim();
      if (!materialBaseId || has.has(materialBaseId)) {
        skipped += 1;
        continue;
      }
      const qty = numOf(it.qty);
      const price = numOf(it.priceBeforeTax);
      const priceWithTax = calcPriceWithTax(price, contractPct);
      const totalWithTax = calcTotalWithTax(priceWithTax, qty);
      maxSort += 1;
      has.add(materialBaseId);
      await this.prisma.contractDraftMaterial.create({
        data: {
          contractId,
          materialBaseId,
          seqNo: maxSort,
          sortOrder: maxSort,
          unit: String(it.unit ?? '').trim(),
          qty,
          priceBeforeTax: price,
          taxRatePct: contractPct,
          priceWithTax,
          totalWithTax,
          remark: it.remark ?? '由采购总清单带入',
        },
      });
      added += 1;
    }
    return { added, skipped };
  }

  /** 保存草稿清单行（含税单价 / 暂定含税合价 服务端统一计算，4 位精度） */
  async draftSave(contractId: string, rows: any[]) {
    await this.assertNotArchived(contractId, '修改合同清单');
    await this.assertContractExists(contractId);
    if (!Array.isArray(rows)) throw new BadRequestException('参数格式错误');
    /**
     * 行 id 必须属于本合同：本接口按行 id 批量写，不校验时拿本合同的 id 作"通行证"
     * 就能改写同项目其它合同的草稿清单（数量/单价被覆盖，从对方界面完全看不出来）。
     */
    const rowIds = [...new Set(rows.map((r: any) => r?.id).filter(Boolean).map(String))];
    if (rowIds.length) {
      const owned = await this.prisma.contractDraftMaterial.findMany({
        where: { id: { in: rowIds }, contractId },
        select: { id: true },
      });
      if (owned.length !== rowIds.length) throw new NotFoundException('清单行不存在');
    }
    // 需求修正2：物料税率不独立存储，保存时一律以合同主表税率为准（前端传值忽略）
    const contractPct = await this.contractTaxPct(contractId);
    // 需求 2.3.2：合同清单计量单位必须存在于字典「measurement_unit」（允许手输，但须先加入字典）
    const unitItems = await this.dict.options('measurement_unit');
    const normalizeUnit = (raw: any): string => {
      const v = String(raw ?? '').trim();
      if (!v) return '';
      const hit = unitItems.find((u: any) => u.itemName === v || u.itemCode === v);
      if (!hit) throw new BadRequestException('计量单位不在字典范围内，请先在字典管理中添加');
      return hit.itemName;
    };
    let saved = 0;
    for (const [i, r] of rows.entries()) {
      if (!r?.id) continue;
      const qty = r.qty == null || r.qty === '' ? null : Number(r.qty);
      const price = r.priceBeforeTax == null || r.priceBeforeTax === '' ? null : Number(r.priceBeforeTax);
      const tax = contractPct;
      const priceWithTax = calcPriceWithTax(price, tax);
      const totalWithTax = calcTotalWithTax(priceWithTax, qty);
      await this.prisma.contractDraftMaterial.update({
        where: { id: r.id },
        data: {
          seqNo: r.seqNo ?? i + 1,
          unit: normalizeUnit(r.unit),
          qty,
          priceBeforeTax: price,
          taxRatePct: tax,
          priceWithTax,
          totalWithTax,
          remark: r.remark ?? null,
          sortOrder: r.sortOrder ?? i + 1,
        },
      });
      saved += 1;
    }
    return { saved };
  }

  async draftRemove(contractId: string, id: string) {
    await this.assertNotArchived(contractId, '修改合同清单');
    await this.assertContractExists(contractId);
    const row = await this.prisma.contractDraftMaterial.findFirst({ where: { id, contractId } });
    if (!row) throw new NotFoundException('清单行不存在');
    await this.prisma.contractDraftMaterial.delete({ where: { id } });
    return true;
  }
}
