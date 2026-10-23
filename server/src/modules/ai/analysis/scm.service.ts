/**
 * 课题 7-11 · **供应链运营分析助理**（跨项目全景）—— service 层。
 *
 * 职责边界与前三个课题一致：
 * - 本 service 只做「按**显式项目集合**取数」+「把数交给纯函数事实层」；
 * - 汇总与全部算术在 `scm-facts.ts`（纯函数、有真值单测）；
 * - 措辞在 `scm-prompt.ts`（模型只组织语言，编数字即整份丢弃改走确定性汇总）。
 *
 * **只读**：不写任何表、不改单据状态、不发通知。
 *
 * == 跨项目这件事必须显式 ==
 * 本项目铁律是「service 的 where 必须带 `projectId`」。这个接口是唯一一个天然跨项目的：
 * 所以①项目集合**只能由前端显式传入**（不传 = 全部，但那样必须有跨项目权限），
 * ②超过 1 个项目就额外要求 `dashboard:view`（统计报表口径）——
 * 不能出现「有 ai:view 就能横着看全部项目经营数据」的越权面。
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { assertPermission } from '../../../common/utils/assert-permission';
import { SysParamService } from '../../../common/services/sys-param.service';
import { AiQuota } from '../ai-quota';
import { aiModelFor } from '../ai-config';
import { AiSettingService } from '../ai-setting.service';
import { chatText } from '../llm-client';
import { auditNumbers } from '../report-facts';
import {
  SCM_PARAM_KEY_LIST,
  parseScmConfig,
  scmToleranceText,
  type ScmConfig,
} from './scm-config.ts';
import {
  buildScmFacts,
  scmFactNumbers,
  scmFactsToMarkdown,
} from './scm-facts.ts';
import { buildScmMessages, missingScmSections, SCM_SECTIONS } from './scm-prompt.ts';
import type { ScmFacts, ScmRows, ScmTolerances } from './scm-types.ts';

/** 一次最多看几个项目（再多就不是「全景」而是导出全库，应当走报表/BI） */
const MAX_PROJECTS = 20;

export interface ScmAnalysisQuery {
  /** 逗号分隔的项目 ID（不传 = 全部项目，但需要跨项目权限） */
  projectIds?: string;
  /** 0/1：强制关闭模型撰写，默认跟随系统参数 `ai.analysis.narrative` */
  narrative?: string;
}

export interface ScmAnalysisResult {
  /** 系统参数 `ai.analysis.enabled` 关掉时为 false（不报错，前端显示「已停用」） */
  enabled: boolean;
  generatedAt: string;
  /** 事实基准日（`YYYY-MM-DD`） */
  asOf: string;
  /** 统计范围的中文描述（面板直接显示） */
  scope: string;
  /** 本次实际统计的项目 */
  projects: Array<{ id: string; code: string; name: string }>;
  sample: Record<string, number>;
  tolerances: ScmTolerances;
  toleranceText: string;
  facts: ScmFacts;
  /** 报告正文（Markdown）：AI 版或确定性汇总版，两者数字同源 */
  markdown: string;
  sections: readonly string[];
  missingSections: string[];
  /** 永远为空数组：对账不过的数字不会进正文（保留字段让面板能直接显示「0 个未对账数字」） */
  unknownNumbers: string[];
  /** 被丢弃的模型数字（透明展示，便于发现「模型在编」） */
  discardedNumbers: string[];
  /** llm = 模型撰写且全量对账通过；template = 确定性汇总 */
  source: 'llm' | 'template';
  warnings: string[];
  usage?: { promptTokens?: number; completionTokens?: number };
}

/**
 * 供应链运营全景（课题 7-11）。
 *
 * 权限：路由层 `ai:view`；service 层 `contract:view`（金额），
 * 跨项目（>1 个项目或不指定项目）再要 `dashboard:view`。
 */
@Injectable()
export class ScmService {
  private readonly logger = new Logger(ScmService.name);

  constructor(
    private prisma: PrismaClient,
    private quota: AiQuota,
    private setting: AiSettingService,
    private sysParam: SysParamService,
  ) {}

  private async config(): Promise<ScmConfig> {
    const values = await Promise.all(SCM_PARAM_KEY_LIST.map((k) => this.sysParam.get(k, '')));
    const raw: Record<string, string | undefined> = {};
    SCM_PARAM_KEY_LIST.forEach((k, i) => {
      raw[k] = values[i] === '' ? undefined : values[i];
    });
    return parseScmConfig(raw);
  }

  async panorama(query: ScmAnalysisQuery, user: any): Promise<ScmAnalysisResult> {
    const userId = user?.userId || user?.username || 'anonymous';
    assertPermission(user, 'contract:view', '供应链全景汇总了合同、结算、付款与开票金额，需要「合同-查看」权限');

    const cfg = await this.config();
    const wanted = this.parseProjectIds(query?.projectIds);
    const crossProject = wanted.length === 0 || wanted.length > 1;
    if (crossProject) {
      assertPermission(
        user,
        'dashboard:view',
        '跨项目供应链全景汇总多个项目的经营数据，需要「统计报表-查看」权限',
      );
    }

    const result: ScmAnalysisResult = {
      enabled: cfg.enabled,
      generatedAt: new Date().toISOString(),
      asOf: this.today(),
      scope: wanted.length === 0 ? '全部项目' : `${wanted.length} 个项目`,
      projects: [],
      sample: {},
      tolerances: cfg.tolerances,
      toleranceText: scmToleranceText(cfg.tolerances),
      facts: {
        asOf: this.today(),
        totals: {
          projectCount: 0,
          contractCount: 0,
          signedYuan: 0,
          settledYuan: 0,
          paidYuan: 0,
          invoicedYuan: 0,
          unpaidYuan: 0,
          uninvoicedYuan: 0,
          payRatioPct: null,
          settleRatioPct: null,
          invoiceRatioPct: null,
          overdueMilestones: 0,
        },
        projects: [],
        suppliers: [],
        risks: [],
        empty: true,
      },
      markdown: '',
      sections: SCM_SECTIONS,
      missingSections: [],
      unknownNumbers: [],
      discardedNumbers: [],
      source: 'template',
      warnings: [...cfg.problems],
    };
    if (!cfg.enabled) return result;

    const collected = await this.collect(wanted, user);
    result.projects = collected.projects;
    result.sample = collected.sample;
    result.scope = collected.scope;
    result.warnings.push(...collected.warnings);

    const facts = buildScmFacts(collected.rows, result.asOf, cfg.tolerances);
    result.facts = facts;
    if (facts.empty) {
      result.warnings.push('所选范围内没有可统计的已签合同，报告只能说明「没有数据」');
    }

    const fallback = scmFactsToMarkdown(facts);
    const narrativeOn = cfg.narrative && String(query?.narrative ?? '') !== '0';
    if (!narrativeOn) {
      result.markdown = fallback;
      result.source = 'template';
      return result;
    }

    try {
      const setting = await this.setting.resolve();
      if (!setting.enabled) {
        result.markdown = fallback;
        result.source = 'template';
        result.warnings.push('AI 未配置（接口地址 / API Key / 模型名），已输出确定性汇总；到「系统管理 → AI 信息登记」填写后可生成叙述版');
        return result;
      }

      this.quota.consume(userId, setting.hourlyLimitPerUser);
      const res = await chatText(
        globalThis.fetch as any,
        {
          baseUrl: setting.baseUrl,
          apiKey: setting.apiKey,
          model: aiModelFor(setting, 'report'),
          timeoutMs: Math.max(setting.timeoutMs, 120000),
          temperature: 0.3,
          maxTokens: setting.maxTokens,
        },
        buildScmMessages(facts),
      ).catch((e: any) => {
        this.quota.refund(userId);
        throw e;
      });

      // 对账：一个对不上的数字就整份丢弃——全景报告是给领导看的，
      // 「大部分数字对、个别是编的」比整份退回模板更危险（读者无法分辨哪句可信）
      const audit = auditNumbers(res.text, scmFactNumbers(facts));
      if (audit.unknown.length) {
        result.markdown = fallback;
        result.source = 'template';
        result.discardedNumbers = audit.unknown;
        result.warnings.push(
          `模型输出含 ${audit.unknown.length} 个无法对账的数字（${audit.unknown.join('、')}），已整份改用确定性汇总；判定与数字本身不受影响`,
        );
      } else {
        result.markdown = res.text;
        result.source = 'llm';
        result.missingSections = missingScmSections(res.text);
        if (result.missingSections.length) {
          result.warnings.push(`模型产出缺少小节：${result.missingSections.join('、')}（正文仍可用）`);
        }
      }
      result.usage = res.usage;
      return result;
    } catch (e: any) {
      const msg = e?.message || String(e);
      this.logger.warn(`供应链全景生成失败：${msg}`);
      result.markdown = fallback;
      result.source = 'template';
      result.warnings.push(`模型调用失败（${msg}），已输出确定性汇总；数字本身不受影响`);
      return result;
    }
  }

  /** `projectIds=a,b,c` → 去重数组（最多 20 个，超出直接 400，不做静默截断） */
  private parseProjectIds(raw?: string): string[] {
    if (!raw) return [];
    const list = String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const unique = Array.from(new Set(list));
    if (unique.length > MAX_PROJECTS) {
      throw new BadRequestException(`一次最多统计 ${MAX_PROJECTS} 个项目，当前传了 ${unique.length} 个`);
    }
    return unique;
  }

  /** 基准日：本地时区的当天（与结算期间口径一致，不用 UTC） */
  private today(): string {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }

  /**
   * 按**显式项目集合**取数。`projectIds` 为空表示全部项目（已在上面过权限闸）。
   * 六张表一次取全，只有窄列；单库几十个项目、几千行是毫秒级。
   */
  private async collect(
    wanted: string[],
    user?: { userId?: string; isSuperAdmin?: boolean },
  ): Promise<{
    rows: ScmRows;
    projects: Array<{ id: string; code: string; name: string }>;
    sample: Record<string, number>;
    scope: string;
    warnings: string[];
  }> {
    const warnings: string[] = [];
    // 项目隔离（铁律 3）：`projectIds` 是**客户端可控参数**，路由也没接 `@ProjectId()`，
    // 所以这里必须自己按成员关系收口——否则任何持 `ai:view`+`contract:view` 的人
    // 传别人的项目 id 就能读走签约/付款/开票金额（IDOR）。
    const projectWhere: any = wanted.length ? { id: { in: wanted } } : {};
    if (user && !user.isSuperAdmin) {
      if (!user.userId) throw new BadRequestException('缺少用户身份，无法校验项目权限');
      projectWhere.members = { some: { userId: user.userId } };
    }
    const projects = await this.prisma.project.findMany({
      where: projectWhere,
      select: { id: true, code: true, name: true },
      orderBy: { code: 'asc' },
    });

    if (!projects.length) {
      return {
        rows: { projects: [], contracts: [], settlements: [], payments: [], invoices: [], milestones: [], suppliers: [] },
        projects: [],
        sample: {},
        scope: '所选范围内没有项目',
        warnings: ['所选范围内没有项目，无法汇总'],
      };
    }

    const ids = projects.map((p) => p.id);
    if (wanted.length && projects.length !== wanted.length) {
      const missing = wanted.filter((id) => !ids.includes(id));
      warnings.push(`有 ${missing.length} 个所选项目不存在、已删除或您不在其成员中，已跳过：${missing.join('、')}`);
    }

    const [contracts, settlements, payments, invoices, milestones] = await Promise.all([
      this.prisma.contract.findMany({
        where: { projectId: { in: ids } },
        select: {
          id: true,
          projectId: true,
          supplierId: true,
          status: true,
          amount: true,
          changeAmount: true,
          parentContractId: true,
        },
      }),
      this.prisma.settlement.findMany({
        where: { projectId: { in: ids } },
        select: { id: true, projectId: true, statusCode: true, amount: true, actualAmount: true },
      }),
      this.prisma.paymentRecord.findMany({
        where: { projectId: { in: ids } },
        select: { id: true, projectId: true, statusCode: true, amount: true },
      }),
      this.prisma.invoice.findMany({
        where: { projectId: { in: ids } },
        select: { id: true, projectId: true, statusCode: true, amountWithTax: true },
      }),
      this.prisma.contractFulfillment.findMany({
        where: { projectId: { in: ids } },
        select: { id: true, projectId: true, statusCode: true, planDate: true },
      }),
    ]);

    const supplierIds = Array.from(new Set(contracts.map((c) => c.supplierId).filter(Boolean) as string[]));
    const suppliers = supplierIds.length
      ? await this.prisma.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true } })
      : [];

    const sample: Record<string, number> = {
      项目: projects.length,
      合同: contracts.length,
      结算单: settlements.length,
      付款: payments.length,
      发票: invoices.length,
      履约节点: milestones.length,
      供应商: suppliers.length,
    };

    if (!contracts.length) warnings.push('所选项目没有任何合同，签约额与后续比例都无法统计');
    if (!milestones.length) warnings.push('所选项目没有任何履约节点，「逾期节点」一项为 0 是因为没有数据');

    return {
      rows: {
        projects,
        contracts: contracts.map((c) => ({
          id: c.id,
          projectId: c.projectId,
          supplierId: c.supplierId,
          status: c.status,
          amount: c.amount,
          changeAmount: c.changeAmount,
          parentContractId: c.parentContractId,
        })),
        settlements,
        payments,
        invoices,
        milestones,
        suppliers,
      },
      projects,
      sample,
      scope:
        wanted.length === 1
          ? `${projects[0].code} ${projects[0].name}`
          : `所选 ${projects.length} 个项目（累计至今）`,
      warnings,
    };
  }
}
