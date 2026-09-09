import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import * as jpeg from 'jpeg-js';

export interface RecognizedInvoice {
  invoiceCode: string | null; // 发票代码（全电发票为空）
  invoiceNo: string | null; // 发票号码（8 位或 20 位）
  amountBeforeTax: number | null; // 不含税金额
  invoiceDate: string | null; // YYYY-MM-DD
}

/**
 * 解析增值税发票左上角二维码内容：
 * 01,10,发票代码,发票号码,不含税金额,开票日期YYYYMMDD,校验码,...
 * 全电发票（数电票）：01,10,,20位号码,金额,日期,...
 */
export function parseInvoiceQr(text: string): RecognizedInvoice | null {
  const parts = String(text || '').split(',').map((s) => s.trim());
  if (parts[0] !== '01' || parts.length < 6) return null;
  const invoiceCode = parts[2] && /^\d{10,12}$/.test(parts[2]) ? parts[2] : null;
  const invoiceNo = /^\d{8,20}$/.test(parts[3]) ? parts[3] : null;
  if (!invoiceNo) return null;
  const amount = Number(parts[4]);
  const raw = parts[5];
  const invoiceDate = /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : null;
  return {
    invoiceCode,
    invoiceNo,
    amountBeforeTax: Number.isFinite(amount) ? amount : null,
    invoiceDate,
  };
}

/** 图片 Buffer → RGBA 像素（支持 PNG / JPEG） */
function toRgba(buffer: Buffer): { data: Uint8ClampedArray; width: number; height: number } | null {
  // PNG 魔数
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50) {
    const png = PNG.sync.read(buffer);
    return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
  }
  // JPEG 魔数
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    const img = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true });
    return { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
  }
  return null;
}

/** 最近邻缩放（二维码过小时放大提高识别率） */
function scale(img: { data: Uint8ClampedArray; width: number; height: number }, factor: number) {
  const w = Math.round(img.width * factor);
  const h = Math.round(img.height * factor);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y / factor));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / factor));
      const si = (sy * img.width + sx) * 4;
      const di = (y * w + x) * 4;
      out[di] = img.data[si];
      out[di + 1] = img.data[si + 1];
      out[di + 2] = img.data[si + 2];
      out[di + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

/** 从发票图片中识别二维码信息（原图 + 1.5x/2x 放大三次尝试） */
export function recognizeInvoiceImage(buffer: Buffer): { ok: true; data: RecognizedInvoice } | { ok: false; error: string } {
  let img: { data: Uint8ClampedArray; width: number; height: number } | null = null;
  try {
    img = toRgba(buffer);
  } catch {
    return { ok: false, error: '无法解析图片（仅支持 PNG/JPG）' };
  }
  if (!img) return { ok: false, error: '无法解析图片（仅支持 PNG/JPG）' };
  for (const factor of [1, 1.5, 2]) {
    const target = factor === 1 ? img : scale(img, factor);
    const code = (typeof jsQR === 'function' ? (jsQR as any) : (jsQR as any).default)(target.data, target.width, target.height);
    if (code?.data) {
      const parsed = parseInvoiceQr(code.data);
      if (parsed) return { ok: true, data: parsed };
      return { ok: false, error: `已识别到二维码但不是增值税发票格式：${code.data.slice(0, 40)}` };
    }
  }
  return { ok: false, error: '未识别到发票二维码，请拍摄包含发票左上角二维码的清晰照片' };
}
