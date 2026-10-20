import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ContractService } from '../contract/contract.service';
import { SupplierService } from '../supplier/supplier.service';
import { AiQuota } from './ai-quota';
import { aiPublicStatus, readAiConfig, type AiConfig } from './ai-config';
import { DOC_EXTS, extOf, extractDocumentText } from './document-text';
import { looksLikeContract } from './docx-text';
import { chatJson, LlmError } from './llm-client';
import { materialRowsFromItems } from './register-materials';
import { normalizeExtraction, type RegisterDraft } from './register-fields';
import { buildRegisterMessages } from './register-prompt';

/** 一次登记的解析结果：**不落库**，等人在前端确认后才写 */
export interface RegisterParseResult {
  aiEnabled: boolean;
  /** AI 不可用时的原因（文件解析成功，但没法自动填） */
  aiMessage?: string;
  fileName: string;
  kind: 'docx' | 'xlsx';
  chars: number;
  truncated: boolean;
  /** 抽出来的草案：字段值 + 原文核对结果 + 明细 */
  draft: RegisterDraft;
  /** 库里已存在的同编号合同 / 同名供应商（前端提示「将关联已有，不重复建」） */
  existing: { supplierId?: string; supplierName?: string; contractId?: string; contractCode?: string };
  items: number;
  model?: string;
}

export interface RegisterConfirmInput {
  supplier?: Record<string, unknown>;
  contract?: Record<string, unknown>;
  /** 直接复用已有供应商（前端下拉选中时传） */
  supplierId?: string;
  /** 只登记合同，不动供应商 */
  skipSupplier?: boolean;
  /** 抽取到的物资明细（写库前由 `materialRowsFromItems` 规整） */
  items?: unknown[];
  /** 是否把明细写入「合同物资明细」（默认不写，用户勾选才写） */
  writeMaterials?: boolean;
}

export interface RegisterConfirmResult {
  supplierId: string | null;
  supplierCreated: boolean;
  contractId: string;
  code: string;
  name: string;
  /** 写入的物资明细行数 */
  materialCount: number;
  /** 新建的物资主数据条数（其余为匹配已有） */
  materialBaseCreated: number;
  /** 因缺名称/重复被丢弃的明细行数 */
  materialSkipped: number;
}

/**
 * 文件自动登记（二期）。
 *
 * 分工刻意写成「解析算子」与「写入算子」两半：
 * - `parse()` 只读文件、只调模型、只做核对，**一个字节都不写库**；
 * - `confirm()` 只接受前端已审阅过的字段，走各模块既有的 create()（编号唯一、名称拼接、
 *   字典校验、付款比例派生都在那里），不另开一条写库捷径。
 * 这样误识别最多是「多看一眼」，不会变成台账里的脏数据。
 */
@Injectable()
export class RegisterService {
  private readonly logger = new Logger(RegisterService.name);

  constructor(
    private prisma: PrismaClient,
    private quota: AiQuota,
    private contracts: ContractService,
    private suppliers: SupplierService,
  ) {}

  private config(): AiConfig {
    return readAiConfig(process.env as Record<string, string | undefined>);
  }

  private assertUpload(file: any, cfg: AiConfig): { buffer: Buffer; fileName: string } {
    if (!file?.buffer?.length) throw new BadRequestException('请上传合同文件');
    const name = String(file.originalname || 'contract.docx');
    const ext = extOf(name);
    if (!DOC_EXTS.includes(ext as any)) {
      throw new BadRequestException(`只支持 ${DOC_EXTS.join(' / ')}（.doc 与 PDF 请先另存为 docx）`);
    }
    if (file.size && file.size > cfg.maxFileBytes) {
      throw new BadRequestException(`文件超过 ${Math.round(cfg.maxFileBytes / 1024 / 1024)}MB，请拆分后上传`);
    }
    return { buffer: file.buffer as Buffer, fileName: name };
  }

  /** 文件 → 草案（不写库） */
  async parse(file: any, ctx: { projectId: string }, userId: string): Promise<RegisterParseResult> {
    const cfg = this.config();
    const { buffer, fileName } = this.assertUpload(file, cfg);

    let doc;
    try {
      doc = await extractDocumentText(buffer, fileName);
    } catch (e: any) {
      throw new BadRequestException(`文件解析失败：${e?.message || '无法读取正文'}`);
    }
    if (!doc.text.trim()) throw new BadRequestException('文件里没有可读文字（扫描件需要先做 OCR）');

    const empty: RegisterDraft = { fields: [], missing: [], warnings: [], items: [], itemsTotal: null };

    // AI 未配置：仍然把文件信息回给前端，但没法抽字段 —— 直接说清楚，让用户走手工新建
    if (!cfg.enabled) {
      return {
        aiEnabled: false,
        aiMessage: 'AI 未配置（AI_BASE_URL / AI_API_KEY / AI_MODEL），无法自动识别，请手工新建或配置后再试',
        fileName,
        kind: doc.kind,
        chars: doc.chars,
        truncated: doc.truncated,
        draft: empty,
        existing: {},
        items: 0,
      };
    }

    this.quota.consume(userId, cfg.hourlyLimitPerUser);

    let raw: unknown;
    try {
      const res = await chatJson(globalThis.fetch as any, {
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        timeoutMs: cfg.timeoutMs,
        temperature: 0,
        maxTokens: cfg.maxTokens,
      }, buildRegisterMessages({ text: doc.text, maxChars: cfg.maxTextChars }));
      raw = res.data;
    } catch (e: any) {
      const msg = e instanceof LlmError ? e.message : String(e?.message || e);
      this.logger.warn(`合同解析失败：${msg}`);
      return {
        aiEnabled: true,
        aiMessage: `AI 识别失败：${msg}（可重试，或手工新建）`,
        fileName,
        kind: doc.kind,
        chars: doc.chars,
        truncated: doc.truncated,
        draft: empty,
        existing: {},
        items: 0,
        model: cfg.model,
      };
    }

    const draft = normalizeExtraction(raw, doc.text);
    if (!looksLikeContract(doc.text)) {
      draft.warnings.unshift('正文里没有明显的合同特征（甲方/乙方/结算等），请确认上传的是合同文件');
    }
    if (doc.truncated) {
      draft.warnings.push(`正文较长已截断（共 ${doc.chars} 字），靠后的条款可能没被识别`);
    }

    const existing = await this.findExisting(draft);
    if (existing.contractCode) draft.warnings.push(`合同编号 ${existing.contractCode} 已存在，登记会因编号重复被拒绝`);
    if (existing.supplierName) draft.warnings.push(`供应商「${existing.supplierName}」已存在，登记时将关联已有记录`);

    return {
      aiEnabled: true,
      fileName,
      kind: doc.kind,
      chars: doc.chars,
      truncated: doc.truncated,
      draft,
      existing,
      items: draft.items.length,
      model: cfg.model,
    };
  }

  private async findExisting(draft: RegisterDraft): Promise<RegisterParseResult['existing']> {
    const out: RegisterParseResult['existing'] = {};
    const supplierName = draft.fields.find((f) => f.key === 'supplier.name')?.value;
    const code = draft.fields.find((f) => f.key === 'contract.code')?.value;
    if (supplierName) {
      const hit = await this.prisma.supplier.findFirst({ where: { name: supplierName } });
      if (hit) {
        out.supplierId = hit.id;
        out.supplierName = hit.name;
      }
    }
    if (code) {
      const hit = await this.prisma.contract.findFirst({ where: { code } });
      if (hit) {
        out.contractId = hit.id;
        out.contractCode = hit.code;
      }
    }
    return out;
  }

  /**
   * 按人工确认后的字段写库。
   * body 用**嵌套结构**（`{supplier:{...}, contract:{...}}`）而不是扁平键：
   * 操作日志的脱敏是按**键名**做的（`common/utils/mask.ts`），嵌套结构才能把
   * `bankAccount` 认出来打码；扁平键 `supplier.bankAccount` 会漏网。
   */
  async confirm(
    input: RegisterConfirmInput,
    ctx: { projectId: string },
    user: any,
  ): Promise<RegisterConfirmResult> {
    const c = input?.contract || {};
    const s = input?.supplier || {};

    const code = str(c.code);
    const name = str(c.name);
    const amount = num(c.amountWithTax ?? c.amount);
    if (!code) throw new BadRequestException('合同编号不能为空');
    if (!name) throw new BadRequestException('合同名称不能为空');
    if (amount === null || amount < 0) throw new BadRequestException('合同金额必须是不小于 0 的数字');

    const signDate = str(c.signDate);
    if (signDate && !/^\d{4}-\d{2}-\d{2}$/.test(signDate)) {
      throw new BadRequestException('签订日期格式应为 YYYY-MM-DD');
    }
    const taxRatePct = num(c.taxRatePct);
    const taxRate = taxRatePct === null ? null : Math.round(taxRatePct) / 100;

    // 1) 供应商：优先复用（前端已选 / 库里同名），否则新建
    let supplierId: string | null = input?.supplierId ? String(input.supplierId) : null;
    let supplierCreated = false;
    if (supplierId) {
      const hit = await this.prisma.supplier.findFirst({ where: { id: supplierId } });
      if (!hit) throw new BadRequestException('选择的供应商不存在');
    } else if (!input?.skipSupplier) {
      const supplierName = str(s.name);
      if (supplierName) {
        const same = await this.prisma.supplier.findFirst({ where: { name: supplierName } });
        if (same) {
          supplierId = same.id;
        } else {
          const created = await this.suppliers.create(
            {
              name: supplierName,
              legalPerson: str(s.legalPerson),
              bankName: str(s.bankName),
              bankAccount: str(s.bankAccount),
              address: str(s.address),
              contactName: str(s.contactName),
              contactPhone: str(s.contactPhone),
              contactEmail: str(s.contactEmail),
            },
            ctx.projectId,
          );
          supplierId = created.id;
          supplierCreated = true;
        }
      }
    }

    // 2) 合同 + 3) 物资明细：同一个事务。
    // 不同事务时，物资行写到一半失败会留下「合同已建、明细只写了一半」的半成品，
    // 再点确认又会被合同编号唯一键拦下（物资明细永远补不上，只能人修库）。
    const written = await this.prisma.$transaction(
      async (tx) => {
        const contract = await this.contracts.create(
          {
            code,
            name,
            autoName: false,
            typeCode: str(c.typeCode) || null,
            supplierId,
            signDate: signDate || null,
            amount,
            taxRate,
            paymentMode: str(c.paymentMode) || null,
            materialDescription: str(c.materialDescription) || null,
            remark: str(c.remark) || null,
            execStatus: 'EXECUTING',
          },
          ctx.projectId,
          user,
          tx as any,
        );

        // 物资明细：用户勾选才写。物资主数据按「名称 + 规格」匹配，缺的先建再挂明细
        let materialCount = 0;
        let materialBaseCreated = 0;
        let materialSkipped = 0;
        if (input?.writeMaterials && Array.isArray(input.items) && input.items.length) {
          const { rows, skipped } = materialRowsFromItems(input.items, taxRatePct);
          materialSkipped = skipped;
          for (const r of rows) {
            let base = await tx.materialBase.findFirst({ where: { name: r.name, spec: r.spec } });
            if (!base) {
              base = await tx.materialBase.create({
                data: { name: r.name, spec: r.spec, unit: r.unit || null, remark: '由 AI 文件登记自动创建' },
              });
              materialBaseCreated += 1;
            }
            await tx.contractMaterial.create({
              data: {
                contractId: contract.id,
                materialBaseId: base.id,
                unit: r.unit,
                qty: r.qty,
                priceBeforeTax: r.priceBeforeTax,
                taxRatePct: r.taxRatePct,
                priceWithTax: r.priceWithTax,
                totalWithTax: r.totalWithTax,
                remark: r.remark,
                sortOrder: r.sortOrder,
              },
            });
            materialCount += 1;
          }
        }
        return { contract, materialCount, materialBaseCreated, materialSkipped };
      },
      { timeout: 60000 },
    );
    const { contract, materialCount, materialBaseCreated, materialSkipped } = written;

    return {
      supplierId,
      supplierCreated,
      contractId: contract.id,
      code: contract.code,
      name: contract.name,
      materialCount,
      materialBaseCreated,
      materialSkipped,
    };
  }
}

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,，\s￥¥元]/g, ''));
  return Number.isFinite(n) ? n : null;
};
