/**
 * **单据模板变量**（付款单）的前端镜像 —— 与后端 `server/src/modules/doc-template/doc-template-vars.ts`
 * 的 `PAYMENT_DOC_VARIABLES` **必须逐条一致**（含 `(元)` 后缀），由 `server/test/docVariables.spec.mts` 锁死。
 *
 * 这是**第三套**变量体系（前两套是采购模板 / 合同模板，互不相通，见 docs/06）：
 * 单据模板的变量只由 `doc-template.service.renderPaymentProcedure()` 替换。
 *
 * ⚠️ **金额类变量名必须带单位后缀**（`(元)`）——同名不同单位视为缺陷（仓库既有约定）。
 */
export interface DocVarItem {
  key: string;
  /**
   * 插入到光标处的原始文本。缺省时编辑器会插 `{{key}}`（渲染器只认双花括号）——
   * 这里仍然显式给出，便于将来出现非 `{{}}` 形态的占位符时不必改编辑器。
   */
  raw?: string;
  tip?: string;
}

export interface DocVarGroup {
  label: string;
  items: DocVarItem[];
}

const v = (key: string, tip?: string): DocVarItem => ({ key, raw: `{{${key}}}`, tip });

export const PAYMENT_DOC_VAR_GROUPS: DocVarGroup[] = [
  {
    label: '单据信息',
    items: [
      v('单据编号', '付款手续编号'),
      v('供应商名称', '取自合同关联的供应商'),
      v('合同编号'),
      v('合同名称'),
      v('开累结算金额(元)', '编制时快照的开累结算金额'),
      v('开累付款金额(元)', '编制时快照的开累付款金额'),
      v('未付款金额(元)', '开累结算 − 开累付款（付超时为负数）'),
      v('付款时间', '未填时保留占位符原文'),
      v('打印日期', '生成单据的当天'),
      v('备注'),
    ],
  },
  {
    label: '项目信息',
    items: [v('项目名称'), v('项目简称'), v('项目编码')],
  },
];
