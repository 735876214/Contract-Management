/** 合同正文导出：Word(.doc) / 打印(PDF) */

const WORD_TPL = (title: string, body: string) => `<html xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:w="urn:schemas-microsoft-com:office:word"
 xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom><w:DoNotOptimizeForBrowser/></w:WordDocument></xml><![endif]-->
<style>
  @page { size: A4; margin: 2.54cm 2cm; }
  body { font-family: "宋体", SimSun, serif; font-size: 12pt; line-height: 1.8; color: #000; }
  h1 { font-size: 18pt; text-align: center; font-family: "黑体", SimHei, sans-serif; }
  h2 { font-size: 14pt; font-family: "黑体", SimHei, sans-serif; }
  table { border-collapse: collapse; width: 100%; margin: 8pt 0; }
  td, th { border: 1px solid #000; padding: 6pt; }
  p { margin: 0 0 8pt; }
  ol, ul { padding-left: 24pt; }
</style>
</head>
<body>
${body}
</body>
</html>`;

function escapeHtml(s: string) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 导出为 Word 文档（.doc，Word/WPS 可直接打开，无需服务端与第三方库）。
 * 使用 MSO 兼容的 HTML 封装，保留富文本排版与表格。
 */
export function exportWord(html: string, filename = '合同正文.doc') {
  const doc = WORD_TPL(filename.replace(/\.doc$/, ''), html || '<p></p>');
  // BOM 保证 Word 以 UTF-8 解析中文
  download(new Blob(['\ufeff' + doc], { type: 'application/msword;charset=utf-8' }), filename);
}

/** 打印 / 另存为 PDF */
export function printHtml(html: string, title = '合同正文') {
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.write(
    `<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      '<style>@page{size:A4;margin:20mm 18mm}body{font-family:"宋体",SimSun,serif;font-size:12pt;line-height:1.8}' +
      'table{border-collapse:collapse;width:100%}td,th{border:1px solid #000;padding:6px}p{margin:0 0 8px}</style>' +
      `</head><body>${html || ''}</body></html>`,
  );
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}

/** 把仍未替换的 {变量} 高亮出来，便于生成后核对 */
export function highlightPlaceholders(html: string) {
  return String(html || '').replace(/\{([^{}]{1,30})\}/g, (_m, g1: string) => {
    if (/^[\s]*$/.test(g1)) return `{${g1}}`;
    return `<span style="background:#fff1b8;border-bottom:1px dashed #d48806;color:#ad6800">{${g1}}</span>`;
  });
}
