import { amountToChineseCapital } from '../src/common/utils/money';
import { patchDocx } from '../src/common/utils/docx-patch';
import HTMLtoDOCX from 'html-to-docx';
import JSZip from 'jszip';

async function main() {
  console.log('=== 1) 金额大写校验 ===');
  const cases: [number, string][] = [
    [0, '零元整'],
    [1234560, '壹佰贰拾叁万肆仟伍佰陆拾元整'],
    [1234.56, '壹仟贰佰叁拾肆元伍角陆分'],
    [100.5, '壹佰元伍角整'],
    [100.05, '壹佰元零伍分'],
    [0.01, '壹分'],
    [1080000.0, '壹佰零捌万元整'],
  ];
  for (const [n, exp] of cases) {
    const r = amountToChineseCapital(n);
    console.log(`  ${n} => ${r}  ${r === exp ? 'OK' : '❌ 期望 ' + exp}`);
  }

  console.log('=== 2) html-to-docx + 底层补丁校验 ===');
  const html =
    '<html><head><meta charset="utf-8"/></head><body><h1>采购合同</h1><p>合同金额：{{合同额大写}}</p></body></html>';
  const buf: any = await HTMLtoDOCX(html, null, {});
  const patched = await patchDocx(Buffer.from(buf), {
    margin: 'narrow',
    header: '合同编号：HT-001    项目名称：紫金街项目',
    footerFormat: 'xofy',
    footerAlign: 'center',
  });

  const zip = await JSZip.loadAsync(patched);
  const doc = await zip.file('word/document.xml')!.async('string');
  const ct = await zip.file('[Content_Types].xml')!.async('string');
  const rels = await zip.file('word/_rels/document.xml.rels')!.async('string');
  const hdr = await zip.file('word/header1.xml')?.async('string');
  const ftr = await zip.file('word/footer1.xml')?.async('string');

  console.log('  docx 字节数:', patched.length);
  console.log('  document.xml 含 pgMar:', /w:pgMar/.test(doc));
  console.log('  document.xml 含 headerReference:', /w:headerReference/.test(doc));
  console.log('  document.xml 含 footerReference:', /w:footerReference/.test(doc));
  console.log('  [Content_Types] 含 header 声明:', /header1\.xml/.test(ct));
  console.log('  rels 含 rIdHdr/rIdFtr:', /rIdHdr/.test(rels) && /rIdFtr/.test(rels));
  console.log('  header1.xml 存在且含文本:', !!hdr, hdr?.includes('合同编号'));
  console.log('  footer1.xml 含 PAGE 域:', ftr?.includes('w:instr="PAGE"'), 'NUMPAGES 域:', ftr?.includes('NUMPAGES'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
