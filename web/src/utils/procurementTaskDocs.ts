/**
 * 任务维度「模块 Word 文档」共享构建与导出（问题一/二）：
 *
 * 此前各模块文档的 docHtml/变量取值只能在各模块页面内基于表单状态构建，
 * 任务查看弹窗（已完成任务查看采购明细 + Word 文件）与列表行「更多 → 导出Word」
 * 需要在不打开页面的情况下按 taskId 直接构建导出，故将各模块
 * 「详情接口取数 → 文档数据映射 → buildXxxDocHtml / buildXxxVariableValues」
 * 的逻辑集中到本文件，与页面内构建共用同一批 buildXxx 工具，保证导出一致。
 *
 * 仅支持已发布（published=true）的模块文档；未发布时抛错由调用方提示。
 */
import dayjs from 'dayjs';
import { procurementTaskApi } from '@/api/modules';
import { projectApi } from '@/api/business';
import { useAuthStore } from '@/store/auth';
import { exportProcurementWord, procurementExportFilename } from '@/utils/procurementExport';
import { buildNoticeDocHtml, buildNoticeVariableValues, type NoticeData } from '@/utils/procurementNotice';
import {
  buildDocumentDocHtml,
  buildDocumentVariableValues,
  type DocumentData,
} from '@/utils/procurementDocument';
import {
  buildPreMeetingDocHtml,
  buildPreMeetingVariableValues,
  type PreMeetingData,
} from '@/utils/preMeetingMinutes';
import {
  buildResultReportDocHtml,
  buildResultReportVariableValues,
  type ResultReportData,
} from '@/utils/procurementResultReport';
import {
  buildPriceCompareDocHtml,
  buildPriceCompareVariableValues,
} from '@/utils/procurementPriceCompare';
import {
  buildExplanationDocHtml,
  buildExplanationVariableValues,
} from '@/utils/frameworkExplanation';

/** 支持按任务导出的模块类型（与采购模板 moduleType / 变量前缀一致） */
export type TaskModuleType = 'PRE_MEETING' | 'NOTICE' | 'DOCUMENT' | 'RESULT_REPORT' | 'PRICE_COMPARE' | 'FRAMEWORK';

export const TASK_MODULE_LABELS: Record<TaskModuleType, string> = {
  PRE_MEETING: '采前会会议纪要',
  NOTICE: '采购公告',
  DOCUMENT: '采购文件',
  RESULT_REPORT: '成交报告',
  PRICE_COMPARE: '采购价格对比表',
  FRAMEWORK: '框架协议事前说明',
};

/** 项目文档上下文（各模块 buildXxx 共用字段） */
interface ProjectDocCtx {
  projectName?: string;
  projectCode?: string;
  projectAbbr?: string;
  undertaker?: string;
  provinceCity?: string;
  siteLocation?: string;
  projectAddress?: string;
  content?: string;
  [k: string]: unknown;
}

/** 当前项目信息（非组件环境从 auth store 取当前项目） */
async function loadProjectCtx(): Promise<ProjectDocCtx> {
  const pid = useAuthStore.getState().currentProjectId;
  if (!pid) return {};
  try {
    const res: any = await projectApi.detail(pid);
    return res ?? {};
  } catch {
    return {};
  }
}

const fmtDate = (v: unknown): string | null => (v ? dayjs(String(v)).format('YYYY-MM-DD') : null);

/**
 * 按 taskId + moduleType 构建模块文档导出入参（docHtml 为含占位符的模块内置文档，
 * 统一管线内完成模板优先与变量替换）。
 * 模块记录不存在或未发布时抛错（message 由调用方统一提示）。
 */
export async function buildTaskModuleDoc(
  moduleType: TaskModuleType,
  taskId: string,
): Promise<{ docHtml: string; values: Record<string, string>; filename: string; taskId: string; moduleType: string }> {
  const fetchers: Record<TaskModuleType, (id: string) => Promise<any>> = {
    PRE_MEETING: (id) => procurementTaskApi.preMeetingMinutes(id),
    NOTICE: (id) => procurementTaskApi.notice(id),
    DOCUMENT: (id) => procurementTaskApi.document(id),
    RESULT_REPORT: (id) => procurementTaskApi.resultReport(id),
    PRICE_COMPARE: (id) => procurementTaskApi.priceCompare(id),
    FRAMEWORK: (id) => procurementTaskApi.frameworkExplanation(id),
  };
  const res: any = await fetchers[moduleType](taskId);
  const d = res?.data ?? res;
  if (!d || d.generated === false) throw new Error('该模块尚未生成');
  if (d.published === false) throw new Error(`${TASK_MODULE_LABELS[moduleType]}尚未发布，无法导出`);

  const task = d.task ?? {};
  const data = d.data ?? {};
  const project = await loadProjectCtx();
  const abbr = project.projectAbbr || project.projectName || '项目';
  const baseCtx: ProjectDocCtx = {
    projectName: project.projectName,
    projectCode: project.projectCode,
    projectAbbr: project.projectAbbr,
    undertaker: project.undertaker,
    provinceCity: project.provinceCity,
    siteLocation: project.siteLocation,
    projectAddress: project.projectAddress,
  };

  let docHtml = '';
  let values: Record<string, string> = {};
  let content = String(task.content ?? '');

  switch (moduleType) {
    case 'NOTICE': {
      content = String(data.content || task.content || '');
      const docData: NoticeData = {
        procurementNo: String(data.procurementNo || task.taskNo || ''),
        procurementTime: fmtDate(data.procurementTime),
        content,
        techQuality: String(data.techQuality ?? ''),
        acceptanceMethod: String(data.acceptanceMethod ?? ''),
        paymentMethod: String(data.paymentMethod ?? ''),
        contacts: (data.contacts ?? []).map((x: unknown) => String(x ?? '')).filter(Boolean),
        contactPhones: (data.contactPhones ?? []).map((x: unknown) => String(x ?? '')).filter(Boolean),
        purchaseItems: d.purchaseItems ?? [],
      };
      const ctx = { ...baseCtx, content };
      docHtml = buildNoticeDocHtml(docData, ctx as never, `${abbr}-${content}-采购公告`);
      values = buildNoticeVariableValues(docData, ctx as never);
      break;
    }
    case 'DOCUMENT': {
      const notice = d.notice ?? {};
      content = String(notice.content || task.content || '');
      const docData: DocumentData = {
        procurementTime: fmtDate(data.procurementTime),
        responseDeposit: data.responseDeposit ?? null,
        quoteDescription: String(data.quoteDescription ?? ''),
        purchaseItems: d.purchaseItems ?? [],
      };
      const ctx = {
        ...baseCtx,
        content,
        procurementNo: notice.procurementNo,
        techQuality: notice.techQuality,
        acceptanceMethod: notice.acceptanceMethod,
        paymentMethod: notice.paymentMethod,
      };
      docHtml = buildDocumentDocHtml(docData, ctx as never, `${abbr}-${content}-采购文件`);
      values = buildDocumentVariableValues(docData, ctx as never);
      break;
    }
    case 'PRE_MEETING': {
      content = String(data.content || task.content || '');
      const docData: PreMeetingData = {
        meetingTime: fmtDate(data.meetingTime),
        content,
        host: String(data.host ?? ''),
        attendees: String(data.attendees ?? ''),
        writer: String(data.writer ?? ''),
        reviewer: String(data.reviewer ?? ''),
        purchaseItems: data.purchaseItems ?? [],
        techQuality: String(data.techQuality ?? ''),
        acceptance: String(data.acceptance ?? ''),
        paymentTerms: String(data.paymentTerms ?? ''),
        costRows: data.costRows ?? [],
      } as PreMeetingData;
      const ctx = { ...baseCtx, content, estimatedAmountWan: d.estimatedAmountWan ?? null };
      docHtml = buildPreMeetingDocHtml(docData, ctx as never, `${abbr}-${content}-采前会会议纪要`);
      values = buildPreMeetingVariableValues(docData, ctx as never);
      break;
    }
    case 'RESULT_REPORT': {
      content = String(d.content || task.content || '');
      const reportData: ResultReportData = {
        unitCount: data.unitCount ?? null,
        openTime: fmtDate(data.openTime),
        openPlace: String(data.openPlace ?? ''),
        reviewMembers: String(data.reviewMembers ?? ''),
        approvedCount: data.approvedCount ?? null,
        participantCount: data.participantCount ?? null,
        abstainCount: data.abstainCount ?? null,
        validFileCount: data.validFileCount ?? null,
        suppliers: Array.isArray(d.suppliers) ? d.suppliers : [],
        candidates: Array.isArray(d.candidates) ? d.candidates : [],
      } as ResultReportData;
      const ctx = { ...baseCtx, content, estimatedAmount: d.estimatedAmount ?? null };
      docHtml = buildResultReportDocHtml(reportData, ctx as never, `${abbr}-${content}-成交报告`);
      values = buildResultReportVariableValues(reportData, ctx as never);
      break;
    }
    case 'PRICE_COMPARE': {
      content = String(d.content || task.content || '');
      const items = (Array.isArray(d.items) ? d.items : []).map((r: any, i: number) => ({
        ...r,
        key: r.materialBaseId ? String(r.materialBaseId) : `row-${i}`,
        materialBaseId: String(r.materialBaseId ?? ''),
        dealPrice: r.dealPrice ?? null,
        remark: r.remark ?? '',
      }));
      const priceData = {
        pricingMethod: String(data.pricingMethod ?? ''),
        benefitAnalysis: String(data.benefitAnalysis ?? ''),
        items,
      };
      const ctx = { ...baseCtx, content };
      docHtml = buildPriceCompareDocHtml(priceData, ctx as never, `${abbr}-${content}-采购价格对比表`);
      values = buildPriceCompareVariableValues(priceData, ctx as never);
      break;
    }
    case 'FRAMEWORK': {
      content = String(task.content || '');
      const form = {
        frameworkIntro: String(data.frameworkIntro ?? ''),
        negotiation: String(data.negotiation ?? ''),
        inquiryRows: data.inquiryRows ?? [],
        priceCompareRows: data.priceCompareRows ?? [],
        execution: String(data.execution ?? ''),
        costRows: data.costRows ?? [],
        referenceSuppliers: (data.referenceSuppliers ?? []).filter((r: any) => String(r?.supplier ?? '').trim()),
      };
      const ctx = { ...baseCtx, content };
      docHtml = buildExplanationDocHtml(form as never, ctx as never, `${abbr}-${content}-框架协议事前说明`);
      values = buildExplanationVariableValues(form as never, ctx as never);
      break;
    }
  }

  return {
    docHtml,
    values,
    filename: procurementExportFilename(abbr, content, moduleType),
    taskId,
    moduleType,
  };
}

/**
 * 按任务导出模块 Word 文档（问题一/二共享入口）：
 * 构建（未发布等场景抛错）→ 统一导出管线下载。返回导出文件名。
 */
export async function exportTaskModuleWord(moduleType: TaskModuleType, taskId: string): Promise<string> {
  const input = await buildTaskModuleDoc(moduleType, taskId);
  await exportProcurementWord({
    moduleType,
    taskId,
    docHtml: input.docHtml,
    values: input.values,
    filename: input.filename,
  });
  return input.filename;
}
