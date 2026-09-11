import JSZip from 'jszip';

/** 页边距预设（单位 twips，1cm ≈ 567 twips） */
const MARGINS: Record<string, { top: number; right: number; bottom: number; left: number }> = {
  normal: { top: 1440, right: 1134, bottom: 1440, left: 1134 }, // 上下2.54 左右2cm
  narrow: { top: 720, right: 720, bottom: 720, left: 720 }, // 1.27cm
  moderate: { top: 1440, right: 1077, bottom: 1440, left: 1077 }, // 上下2.54 左右1.9cm
  wide: { top: 1800, right: 1800, bottom: 1800, left: 1800 }, // 3.18cm
};

export interface PageSetup {
  margin?: 'normal' | 'narrow' | 'moderate' | 'wide';
  /** 页眉文本，可含 {变量名}（导出前由调用方解析） */
  header?: string;
  footerFormat?: 'xofy' | 'xy' | 'dash';
  footerAlign?: 'center' | 'right' | 'left';
}

function escapeXml(s: string): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

/** 页脚 XML：含 PAGE / NUMPAGES 域，支持三种格式与对齐 */
function footerXml(setup: PageSetup): string {
  const align = setup.footerAlign || 'center';
  const pageField = '<w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple>';
  const numField = '<w:fldSimple w:instr="NUMPAGES"><w:r><w:t>1</w:t></w:r></w:fldSimple>';
  let middle: string;
  if (setup.footerFormat === 'xy') {
    middle = `${pageField}<w:r><w:t xml:space="preserve"> / </w:t></w:r>${numField}`;
  } else if (setup.footerFormat === 'dash') {
    middle = `<w:r><w:t xml:space="preserve">- </w:t></w:r>${pageField}<w:r><w:t xml:space="preserve"> -</w:t></w:r>`;
  } else {
    middle = `<w:r><w:t xml:space="preserve">第 </w:t></w:r>${pageField}<w:r><w:t xml:space="preserve"> 页 / 共 </w:t></w:r>${numField}<w:r><w:t xml:space="preserve"> 页</w:t></w:r>`;
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:p><w:pPr><w:jc w:val="${align}"/></w:pPr>${middle}</w:p></w:ftr>`;
}

function headerXml(header: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(header || '')}</w:t></w:r></w:p></w:hdr>`;
}

/**
 * 在 html-to-docx 生成的基础 docx 之上做底层 XML 补丁：
 * - 写入真实页边距（pgMar）与 A4 页面尺寸（pgSz）
 * - 注入页眉 / 页脚部件，并在 sectPr 中建立引用
 * - 页脚含 PAGE / NUMPAGES 域（Word 打开时自动计算页码）
 */
export async function patchDocx(buffer: Buffer | Uint8Array, setup?: PageSetup | null): Promise<Buffer> {
  if (!setup) return Buffer.from(buffer);
  const zip = await JSZip.loadAsync(buffer);
  const margin = MARGINS[setup.margin || 'normal'] || MARGINS.normal;

  const docPath = 'word/document.xml';
  let docXml = await zip.file(docPath)?.async('string');
  if (docXml) {
    const bodyEnd = docXml.lastIndexOf('</w:body>');
    const sectStart = bodyEnd >= 0 ? docXml.lastIndexOf('<w:sectPr', bodyEnd) : -1;

    const refs = `<w:headerReference w:type="default" r:id="rIdHdr"/><w:footerReference w:type="default" r:id="rIdFtr"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="${margin.top}" w:right="${margin.right}" w:bottom="${margin.bottom}" w:left="${margin.left}" w:header="720" w:footer="720" w:gutter="0"/>`;

    if (sectStart >= 0) {
      const sectEnd = docXml.indexOf('</w:sectPr>', sectStart) + '</w:sectPr>'.length;
      const original = docXml.slice(sectStart, sectEnd);
      // 清除可能已存在的页面设置/引用，避免重复
      const cleaned = original
        .replace(/<w:headerReference[^>]*\/>/g, '')
        .replace(/<w:footerReference[^>]*\/>/g, '')
        .replace(/<w:pgSz[^>]*\/>/g, '')
        .replace(/<w:pgMar[^>]*\/>/g, '');
      const newSectPr = cleaned.replace(/<w:sectPr([^>]*)>/, `<w:sectPr$1>${refs}`);
      docXml = docXml.slice(0, sectStart) + newSectPr + docXml.slice(sectEnd);
    } else if (bodyEnd >= 0) {
      const newSectPr = `<w:sectPr>${refs}</w:sectPr>`;
      docXml = docXml.slice(0, bodyEnd) + newSectPr + docXml.slice(bodyEnd);
    }
    zip.file(docPath, docXml);
  }

  // 页眉 / 页脚部件
  zip.file('word/header1.xml', headerXml(setup.header || ''));
  zip.file('word/footer1.xml', footerXml(setup));

  // [Content_Types].xml 增加部件声明
  let ct = await zip.file('[Content_Types].xml')?.async('string');
  if (ct && !/header1\.xml/.test(ct)) {
    ct = ct.replace(
      '</Types>',
      `<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`,
    );
    zip.file('[Content_Types].xml', ct);
  }

  // document.xml.rels 增加引用关系
  const relsPath = 'word/_rels/document.xml.rels';
  let rels = await zip.file(relsPath)?.async('string');
  if (rels && !/rIdHdr/.test(rels)) {
    rels = rels.replace(
      '</Relationships>',
      `<Relationship Id="rIdHdr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rIdFtr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`,
    );
    zip.file(relsPath, rels);
  }

  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return Buffer.from(out);
}
