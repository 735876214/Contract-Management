import { CSCEC_LOGO_PNG_BASE64 } from '../../common/services/cscec-logo.base64';

/**
 * 分包材料员授权委托书（表格编号：CCCEC-SW-B40410）渲染
 *
 * 版式严格对齐附件《分包材料员授权委托书.xlsx》：
 *  - 第一行：左「中国建筑」标识 + 右「项目管理表格」
 *  - 第二行：表格标题「分包材料员授权委托书」
 *  - 第三行：右侧「表格编号 CCCEC-SW-B40410」
 *  - 正文：抬头单位 + 授权声明 + 代理期限 + 代理人信息表 + 落款
 *
 * 导出 PDF 时前端调用浏览器打印管道；此模块产出「打印就绪」的完整 HTML，
 * 既可由前端 window.open 打印另存 PDF，也可作为 Word(.doc) 导出的正文。
 */

export interface SubcontractorLetterData {
  subcontractorName?: string | null;
  subcontractContent?: string | null;
  subcontractId?: string | null;
  legalPerson?: string | null;
  authorizedPerson?: string | null;
  authorizedPersonIdNo?: string | null;
  projectName?: string | null;
  remark?: string | null;
}

/** HTML 转义，避免分/子公司名称中的特殊字符破坏版式 */
export function esc(s: any): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/** 空值占位，保持版式不塌陷 */
const v = (s: any) => (String(s ?? '').trim() ? esc(s) : '&nbsp;');

const LOGO_SRC = `data:image/png;base64,${CSCEC_LOGO_PNG_BASE64}`;

/**
 * 渲染委托书 HTML（打印 / 另存 PDF 与 .doc 共用同一份正文）
 * @param data 分包商信息
 * @param opts.withChrome 是否输出带 <html> 的完整文档（false 时仅返回 body 片段）
 */
export function renderSubcontractorLetter(data: SubcontractorLetterData, opts: { withChrome?: boolean } = {}): string {
  const { withChrome = true } = opts;
  const subcontractor = data.subcontractorName || '';
  const legalPerson = data.legalPerson || '';
  const authorizedPerson = data.authorizedPerson || '';
  const projectName = data.projectName || '';
  const subcontractContent = data.subcontractContent || '';

  const body = `
<table class="csc-head">
  <tr>
    <td class="csc-brand"><img class="csc-logo" src="${LOGO_SRC}" alt="中国建筑" /></td>
    <td class="csc-brand-text">项目管理表格</td>
  </tr>
</table>

<table class="csc-titlebox">
  <tr>
    <td class="csc-title">分包材料员授权委托书</td>
    <td class="csc-code"><span>表格编号</span><span class="csc-code-no">CCCEC-SW-B40410</span></td>
  </tr>
</table>

<p class="csc-to">${projectName ? esc(projectName) : '中国建筑第八工程局有限公司'}：</p>

<p class="csc-p">本人 <b>${v(legalPerson)}</b>（法定代表人）系 <b>${v(subcontractor)}</b> 的法定代表人，现授权委托本公司员工 <b>${v(authorizedPerson)}</b>（身份证号：<b>${v(data.authorizedPersonIdNo)}</b>）为 <b>${v(projectName)}</b> 项目的材料员，代表本公司负责与贵司办理 <b>${v(subcontractContent) || '本项目'} </b>相关的材料领用、验收、对账、结算等事宜。</p>

<p class="csc-p">授权期限：自本委托书签署之日起至上述事宜办理完毕之日止。受托人在授权范围内签署的一切文件及处理的相关事务，本公司均予承认，并承担相应的法律责任。</p>

<p class="csc-p">特此委托。</p>

<table class="csc-info">
  <tr>
    <td class="csc-label">分包商名称</td>
    <td class="csc-value" colspan="3">${v(subcontractor)}</td>
  </tr>
  <tr>
    <td class="csc-label">法定代表人</td>
    <td class="csc-value">${v(legalPerson)}</td>
    <td class="csc-label">授权人姓名</td>
    <td class="csc-value">${v(authorizedPerson)}</td>
  </tr>
  <tr>
    <td class="csc-label">授权人身份证号</td>
    <td class="csc-value">${v(data.authorizedPersonIdNo)}</td>
    <td class="csc-label">项目名称</td>
    <td class="csc-value">${v(projectName)}</td>
  </tr>
  <tr>
    <td class="csc-label">分包合同内容</td>
    <td class="csc-value" colspan="3">${v(subcontractContent)}</td>
  </tr>
  ${
    data.remark
      ? `<tr><td class="csc-label">备注</td><td class="csc-value" colspan="3">${esc(data.remark)}</td></tr>`
      : ''
  }
</table>

<table class="csc-sign">
  <tr>
    <td class="csc-sign-cell">
      <div class="csc-sign-label">法定代表人（签字）：</div>
      <div class="csc-sign-line"></div>
    </td>
    <td class="csc-sign-cell">
      <div class="csc-sign-label">分包商（盖章）：</div>
      <div class="csc-sign-line"></div>
    </td>
  </tr>
  <tr>
    <td class="csc-sign-cell">
      <div class="csc-sign-label">日期：</div>
      <div class="csc-sign-line"></div>
    </td>
    <td class="csc-sign-cell">
      <div class="csc-sign-label">日期：</div>
      <div class="csc-sign-line"></div>
    </td>
  </tr>
</table>
`;

  const style = `
<style>
  @page { size: A4 portrait; margin: 20mm 18mm; }
  * { box-sizing: border-box; }
  body { font-family: "宋体", SimSun, serif; font-size: 12pt; line-height: 1.8; color: #000; margin: 0; }
  table { border-collapse: collapse; width: 100%; }

  .csc-head { margin-bottom: 0; }
  .csc-brand { width: 120px; vertical-align: middle; }
  .csc-logo { height: 34px; }
  .csc-brand-text { text-align: right; vertical-align: middle; font-family: "黑体", SimHei, sans-serif; font-size: 14pt; letter-spacing: 2px; }

  .csc-titlebox { margin-bottom: 14pt; }
  .csc-title { font-family: "黑体", SimHei, sans-serif; font-size: 16pt; font-weight: bold; text-align: center; padding: 6pt 0; }
  .csc-code { width: 170px; text-align: right; vertical-align: top; font-size: 10.5pt; white-space: nowrap; }
  .csc-code span { display: inline-block; }
  .csc-code-no { margin-left: 6px; letter-spacing: 0.5px; }

  .csc-to { margin: 10pt 0 6pt; font-weight: bold; }
  .csc-p { margin: 0 0 8pt; text-indent: 2em; text-align: justify; }
  .csc-p b { text-decoration: underline; text-underline-offset: 3px; font-weight: normal; }

  .csc-info { margin: 12pt 0; }
  .csc-info td { border: 1px solid #000; padding: 6pt 8pt; }
  .csc-label { width: 110px; background: #f2f2f2; text-align: center; white-space: nowrap; }
  .csc-value { min-height: 22pt; }

  .csc-sign { margin-top: 24pt; }
  .csc-sign-cell { width: 50%; border: none; padding: 0 8pt 18pt 0; vertical-align: bottom; }
  .csc-sign-label { margin-bottom: 26pt; }
  .csc-sign-line { border-bottom: 1px solid #000; height: 1px; }
</style>`;

  if (!withChrome) return body;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>分包材料员授权委托书</title>
${style}
</head>
<body>${body}</body>
</html>`;
}

/** 附件要求：分包材料员授权委托书_{分包商名称}_{日期}.pdf */
export function letterFileName(subcontractorName: string, date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
  const safe = String(subcontractorName || '分包商').replace(/[\\/:*?"<>|\s]/g, '');
  return `分包材料员授权委托书_${safe}_${stamp}.pdf`;
}
