import type { Dateish, Decimalish, Paged, Versioned } from './common.ts';

/**
 * 合同域的响应/请求类型。
 *
 * ## 真理源
 * - 列表行：`server/src/modules/contract/contract.service.ts#findAll` —— Prisma `Contract` 行（44 个标量
 *   + id/createdAt/version/updatedAt）+ `supplier`（精简选择集）+ `ext`（整行 ContractExt）；
 * - 详情：同文件 `findOne` —— 再加 `attachments` / `project` / `parentContract` / `supplements`
 *   以及四个条款对象（technical/quality/payment/acceptance）。
 *
 * ## 三个必须记住的点
 * 1. **金额/数量对外一律 number**（2026-11-24 收口：`contract.service` 读路径统一过
 *    `normalizeContractDecimals()`，与台账同口径）。此前 Decimal 原样下发是 **string**，
 *    导致同一笔钱「台账是 number、合同是 string」，那条不一致已消除。
 *    `amount（主合同）+ Σ changeAmount（带符号）`，实现见 `server/src/domain/contract-chain.ts`。
 * 3. `status`（起草流转 DRAFT/COMPLETED）与 `execStatus`（执行情况字典）是**两个不同字段**，
 *    页面上的「状态」列到底取哪个由业务口径决定，别混用。
 */

/** 合同列表里的供应商摘要（`findAll` 的 `supplier.select`）。 */
export interface ContractSupplierBrief {
  id: string;
  name: string;
  legalPerson: string | null;
  contactName: string | null;
  contactPhone: string | null;
}

/** 合同行（`GET /contracts`）—— 50 键 = 44 标量 + 4 元数据 + supplier + ext。 */
export interface ContractRow {
  id: string;
  projectId: string;
  /** 合同编号 */
  code: string;
  name: string;
  /** dict: contract_type */
  typeCode: string | null;
  /** dict: contract_sub_type 合同子类型（编号第4段） */
  subTypeCode: string | null;
  supplierId: string | null;
  signDate: Dateish;
  amount: number | null;
  /** 税率（百分数，如 13.00） */
  taxRatePct: number | null;
  /** dict: payment_method */
  paymentMethodCode: string | null;
  /** dict: yes_no */
  isFramework: string | null;
  /** dict: yes_no */
  isSupplement: string | null;
  /** 主合同ID（补充协议链） */
  parentContractId: string | null;
  /** 年度顺序码（合同编号生成规则，如 2026001） */
  yearSeq: string | null;
  /** 编号第3段项目字母简称（生成时固化） */
  codeAbbrUsed: string | null;
  /** 补充协议序号 */
  supplementSeq: number | null;
  /** dict: supplement_agreement_type */
  supplementTypeCode: string | null;
  /** 该补充协议带来的带符号增量（增项为正、减项为负） */
  changeAmount: number | null;
  /** 带符号数量增量（同上） */
  changeQty: number | null;
  /** 变更生效日 */
  changeEffectiveDate: Dateish;
  /** dict: contract_execution_status */
  execStatus: string | null;
  /** dict: contract_status 起草流转状态：DRAFT 草稿中 / COMPLETED 已完成 */
  status: string | null;
  /** 关联合同模板 ID（起草时选择，用于回填与预览） */
  templateId: string | null;
  /** 模板变量填写值（JSON 文本，key=变量键） */
  formData: string | null;
  /** 物资名称（合同名称第4段，用户手填，如：PE管） */
  materialDescription: string | null;
  /** 技术条款 ID（需求 2.3：创建合同时选择） */
  technicalClauseId: string | null;
  /** 质量条款 ID */
  qualityClauseId: string | null;
  /** 付款条件 ID */
  paymentClauseId: string | null;
  /** 验收方式 ID */
  acceptanceClauseId: string | null;
  /** 签章合同文件相对路径（相对上传目录，需求：合同签章） */
  signedFilePath: string | null;
  /** 签章合同原始文件名 */
  signedFileName: string | null;
  /** 签章时记录的签订日期 */
  signedDate: Dateish;
  /** 签章备注 */
  signedRemark: string | null;
  /** 签章操作时间（每次签章/重新签章刷新） */
  signedAt: Dateish;
  /** JSON：{ name, bankName, bankAccount, legalPerson, ... } */
  supplierSnapshot: string | null;
  remark: string | null;
  /** 资金费用-付款模式：100 / 3382 / CUSTOM（可覆盖系统默认） */
  paymentMode: string | null;
  /** 延期月利率（如 0.006 表示 0.6%） */
  monthlyRate: number | null;
  /** 逾期宽限天数 */
  graceDays: number | null;
  /** 逾期利息上限比例（如 0.05 表示 5%） */
  interestCapRatio: number | null;
  createdBy: string | null;
  /** 关联采购任务（一对多：一个任务可生成多个合同） */
  taskId: string | null;
  archivedAt: Dateish;
  /** 归档人姓名快照（弱关联 User） */
  archivedBy: string | null;
  createdAt: string;
  /** 乐观锁版本号（更新时必须回传，否则 409） */
  version: number;
  updatedAt: string;
  /** 供应商摘要（列表 include 的选择集；详情里是整行 Supplier） */
  supplier: ContractSupplierBrief | null;
  /** 合同扩展字段（整行 ContractExt：招标/定标/财务编号/付款比例/分供方类别 …，30+ 字段，本期不逐个声明） */
  ext: (Record<string, unknown> & { id?: string }) | null;
}

export const CONTRACT_ROW_KEYS = [
  'id',
  'projectId',
  'code',
  'name',
  'typeCode',
  'subTypeCode',
  'supplierId',
  'signDate',
  'amount',
  'taxRatePct',
  'paymentMethodCode',
  'isFramework',
  'isSupplement',
  'parentContractId',
  'yearSeq',
  'codeAbbrUsed',
  'supplementSeq',
  'supplementTypeCode',
  'changeAmount',
  'changeQty',
  'changeEffectiveDate',
  'execStatus',
  'status',
  'templateId',
  'formData',
  'materialDescription',
  'technicalClauseId',
  'qualityClauseId',
  'paymentClauseId',
  'acceptanceClauseId',
  'signedFilePath',
  'signedFileName',
  'signedDate',
  'signedRemark',
  'signedAt',
  'supplierSnapshot',
  'remark',
  'paymentMode',
  'monthlyRate',
  'graceDays',
  'interestCapRatio',
  'createdBy',
  'taskId',
  'archivedAt',
  'archivedBy',
  'createdAt',
  'version',
  'updatedAt',
  'supplier',
  'ext',
] as const;

/** 允许缺席的键（Prisma 标量列一律返回；`ext`/`supplier` 为 null 时键仍在，故当前没有）。 */
export const CONTRACT_ROW_OPTIONAL_KEYS = [] as const;

/** `GET /contracts` 认的查询参数（注意是 `code`/`name`/`execStatus`，不是台账那套 `contractCode`）。 */
export const CONTRACT_LIST_PARAM_KEYS = [
  'page',
  'pageSize',
  'keyword',
  'code',
  'name',
  'typeCode',
  'supplierId',
  'execStatus',
  'startDate',
  'endDate',
] as const;

export interface ContractListParams {
  page?: number;
  pageSize?: number;
  keyword?: string;
  /** 合同编号（模糊） */
  code?: string;
  /** 合同名称（模糊） */
  name?: string;
  typeCode?: string;
  supplierId?: string;
  execStatus?: string;
  /** 签订日期区间（`YYYY-MM-DD`，服务端走本地日原语） */
  startDate?: string;
  endDate?: string;
}

/**
 * 合同详情（`GET /contracts/:id`）。
 * 除列表那些字段外，多出：四个条款、附件、项目摘要、主合同摘要、补充协议列表。
 */
export interface ContractDetail extends Omit<ContractRow, 'supplier'> {
  /** 详情返回**整行 Supplier**（含开户行/账号/税号等），比列表的精简集更全 */
  supplier: (Record<string, unknown> & { id: string; name: string }) | null;
  attachments: Array<Record<string, unknown> & { id: string; fileName?: string | null }>;
  project: { id: string; name: string; codeAbbr: string | null; industryType: string | null } | null;
  parentContract: { id: string; code: string; name: string } | null;
  supplements: Array<{ id: string; code: string; name: string }>;
  /** 四个条款对象（服务端 `findOne` 返回的是**嵌套**的 `clauses`，不是平铺字段；未选的为 null） */
  clauses: {
    technical: Record<string, unknown> | null;
    quality: Record<string, unknown> | null;
    payment: Record<string, unknown> | null;
    acceptance: Record<string, unknown> | null;
  };
}

/** 新建/更新合同（字段与后端写入白名单一致；服务端还会做编号生成与链增量重算）。 */
export interface ContractWritePayload {
  code?: string;
  name?: string;
  typeCode?: string | null;
  subTypeCode?: string | null;
  supplierId?: string | null;
  signDate?: Dateish;
  amount?: Decimalish | null;
  taxRatePct?: Decimalish | null;
  paymentMethodCode?: string | null;
  isFramework?: string | null;
  isSupplement?: string | null;
  parentContractId?: string | null;
  supplementTypeCode?: string | null;
  execStatus?: string | null;
  status?: string | null;
  templateId?: string | null;
  /**
   * 模板变量填写值。**读**下来是 JSON 文本（DB 里存 `String`）；**写**时既可以是 JSON 文本，
   * 也可以是普通对象——服务端 `contract.service.ts:908` 会把非字符串 `JSON.stringify` 后落库
   * （`SupplementDraft.tsx` 就是直接传对象）。`null` 表示没有变量值。
   */
  formData?: string | Record<string, unknown> | null;
  materialDescription?: string | null;
  technicalClauseId?: string | null;
  qualityClauseId?: string | null;
  paymentClauseId?: string | null;
  acceptanceClauseId?: string | null;
  remark?: string | null;
  paymentMode?: string | null;
  monthlyRate?: Decimalish | null;
  graceDays?: number | null;
  interestCapRatio?: Decimalish | null;
}
export type ContractUpdatePayload = Partial<ContractWritePayload> & Versioned;

/** 合同下拉选项（`GET /contracts/options`）。 */
export interface ContractOption {
  id: string;
  code: string;
  name: string;
}

/** 编号重复校验结果（`GET /contracts/check-code`）。 */
export interface ContractCodeCheck {
  /** 是否已被占用 */
  exists: boolean;
}

export type ContractListResponse = Paged<ContractRow>;
