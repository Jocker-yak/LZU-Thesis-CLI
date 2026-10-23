/**
 * 最小 PDF 写出器：把服务器给的 JPEG 原样嵌入（/Filter /DCTDecode），不重编码。
 *
 * 为什么不用 jsPDF：① 400KB 依赖；② 需要 DOM/Canvas；③ 会重编码图片丢细节。
 * 这里只依赖 Uint8Array，Chrome service worker 里也能跑。
 *
 * 输出结构（经典 xref 表，所有阅读器都认）：
 *   1 Catalog / 2 Pages / 3 Info
 *   每页 3 个对象：Page / Contents / Image XObject
 */

const encoder = new TextEncoder();

/** 文本 → ASCII 字节（PDF 语法部分只允许 ASCII，中文走 UTF-16BE 十六进制串）。 */
const ascii = (s) => encoder.encode(s);

class ByteSink {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  push(bytes) {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  pushText(s) {
    this.push(ascii(s));
  }

  toUint8Array() {
    const out = new Uint8Array(this.length);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}

/** PDF 数字：保留最多 2 位小数，去掉多余的 .00。 */
function num(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

/** PDF 文本串：ASCII 用 (...)，含中文用 UTF-16BE 十六进制串。 */
export function pdfString(text) {
  const s = String(text ?? '');
  if (/^[\x20-\x7e]*$/.test(s)) {
    return '(' + s.replace(/[\\()]/g, (c) => '\\' + c) + ')';
  }
  let hex = 'FEFF';
  const bytes = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    bytes[i * 2] = code >> 8;
    bytes[i * 2 + 1] = code & 0xff;
    hex += (code >> 8).toString(16).padStart(2, '0') + (code & 0xff).toString(16).padStart(2, '0');
  }
  return '<' + hex.toUpperCase() + '>';
}

/**
 * 嗅探 JPEG 的尺寸 / 分量数 / Adobe transform。
 * @param {Uint8Array} bytes
 * @returns {{width:number,height:number,components:number,adobeTransform:number|null}}
 */
export function jpegInfo(bytes) {
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('不是 JPEG 数据（缺少 FFD8 头）');
  }
  let pos = 2;
  let adobeTransform = null;
  while (pos + 3 < bytes.length) {
    if (bytes[pos] !== 0xff) {
      pos++;
      continue;
    }
    const marker = bytes[pos + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // 进入压缩数据，SOF 已经读过了
    const len = (bytes[pos + 2] << 8) | bytes[pos + 3];
    if (len < 2 || pos + 2 + len > bytes.length) break;
    // SOF0/1/2/3/5/6/7/9/10/11/13/14/15（不含 DHT C4 / JPG C8 / DAC CC）
    const isSOF = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      const height = (bytes[pos + 5] << 8) | bytes[pos + 6];
      const width = (bytes[pos + 7] << 8) | bytes[pos + 8];
      const components = bytes[pos + 9];
      return { width, height, components, adobeTransform };
    }
    if (marker === 0xee) {
      // APP14 "Adobe"
      const data = bytes.subarray(pos + 4, pos + 2 + len);
      if (data.length >= 12 && data[0] === 0x41 && data[1] === 0x64 && data[2] === 0x6f
        && data[3] === 0x62 && data[4] === 0x65) {
        adobeTransform = data[11];
      }
    }
    pos += 2 + len;
  }
  throw new Error('JPEG 里找不到 SOF 段，读不出尺寸');
}

/**
 * 合成 PDF。
 * @param {Array<{jpeg:Uint8Array, info:{width:number,height:number,components:number,adobeTransform:number|null}}>} pages
 * @param {{title?:string, producer?:string, resolution?:number}} [opts]
 *        resolution：每英寸像素数，只影响 PDF 里标注的物理尺寸（与 CLI 默认 150 一致）。
 * @returns {Uint8Array}
 */
export function buildPdf(pages, opts = {}) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('没有任何页面，无法合成 PDF');
  }
  const resolution = Number(opts.resolution) > 0 ? Number(opts.resolution) : 150;
  const n = pages.length;
  const sink = new ByteSink();
  const offsets = []; // 索引 = 对象号

  sink.pushText('%PDF-1.4\n');
  sink.push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const beginObj = (id) => {
    offsets[id] = sink.length;
    sink.pushText(`${id} 0 obj\n`);
  };
  const endObj = () => sink.pushText('endobj\n');

  // 1: Catalog
  beginObj(1);
  sink.pushText('<< /Type /Catalog /Pages 2 0 R >>\n');
  endObj();

  // 2: Pages
  const kids = pages.map((_, i) => `${4 + 3 * i} 0 R`).join(' ');
  beginObj(2);
  sink.pushText(`<< /Type /Pages /Kids [ ${kids} ] /Count ${n} >>\n`);
  endObj();

  // 3: Info
  beginObj(3);
  const infoParts = ['/Producer ' + pdfString(opts.producer || 'LZU Fulltext extension')];
  if (opts.title) infoParts.push('/Title ' + pdfString(opts.title));
  infoParts.push('/Creator ' + pdfString(opts.creator || 'LZU Fulltext extension'));
  sink.pushText(`<< ${infoParts.join(' ')} >>\n`);
  endObj();

  for (let i = 0; i < n; i++) {
    const page = pages[i];
    const { width, height, components } = page.info;
    const pageW = (width * 72) / resolution;
    const pageH = (height * 72) / resolution;
    const pageId = 4 + 3 * i;
    const contentId = pageId + 1;
    const imageId = pageId + 2;

    // Page
    beginObj(pageId);
    sink.pushText(
      `<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 ${num(pageW)} ${num(pageH)} ] `
      + `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>\n`,
    );
    endObj();

    // Contents：把 1x1 的单位方块缩放贴到整页
    const content = `q\n${num(pageW)} 0 0 ${num(pageH)} 0 0 cm\n/Im0 Do\nQ\n`;
    const contentBytes = ascii(content);
    beginObj(contentId);
    sink.pushText(`<< /Length ${contentBytes.length} >>\nstream\n`);
    sink.push(contentBytes);
    sink.pushText('endstream\n');
    endObj();

    // Image XObject：原始 JPEG 字节直接塞进 DCTDecode 流
    let colorSpace = '/DeviceRGB';
    let decode = '';
    if (components === 1) colorSpace = '/DeviceGray';
    else if (components === 4) {
      colorSpace = '/DeviceCMYK';
      // Adobe 写的 CMYK/YCCK JPEG 是反相存储的，需要 Decode 反转
      if (page.info.adobeTransform !== null) decode = ' /Decode [1 0 1 0 1 0]';
    }
    const jpeg = page.jpeg;
    beginObj(imageId);
    sink.pushText(
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} `
      + `/ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode${decode} `
      + `/Length ${jpeg.length} >>\nstream\n`,
    );
    sink.push(jpeg);
    sink.pushText('\nendstream\n');
    endObj();
  }

  const xrefStart = sink.length;
  const total = 3 + 3 * n + 1; // 对象数 + 1（0 号占位）
  sink.pushText(`xref\n0 ${total}\n`);
  sink.pushText('0000000000 65535 f \n');
  for (let id = 1; id < total; id++) {
    sink.pushText(`${String(offsets[id] || 0).padStart(10, '0')} 00000 n \n`);
  }
  sink.pushText(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

  return sink.toUint8Array();
}

/** 把文档标题变成安全的文件名（逐字复刻 pdfbuild.safe_name）。 */
export function safeName(name, { fallback = 'document', limit = 80 } = {}) {
  const bad = '\\/:*?"<>|\r\n\t';
  let out = '';
  for (const ch of String(name || '')) out += bad.includes(ch) ? '_' : ch;
  out = out.replace(/^[ .]+/, '').replace(/[ .]+$/, '');
  return (out || fallback).slice(0, limit);
}
