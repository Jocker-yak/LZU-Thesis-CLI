/**
 * 生成插件图标（16/32/48/128 PNG），纯 Node、零依赖：
 * 蓝底圆角方块 + 白色文稿 + 蓝色下载箭头。
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- PNG 编码

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4)
      .copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- 绘制

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const lerp = (a, b, t) => a + (b - a) * t;

function makeCanvas(size) {
  return { size, px: new Uint8Array(size * size * 4) };
}

function setPixel(canvas, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) return;
  const i = (y * canvas.size + x) * 4;
  canvas.px[i] = r;
  canvas.px[i + 1] = g;
  canvas.px[i + 2] = b;
  canvas.px[i + 3] = a;
}

/** 圆角矩形填充，支持每像素颜色回调与 4x4 超采样抗锯齿。 */
function roundedRect(canvas, x0, y0, x1, y1, radius, colorAt) {
  const ss = 4;
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      let hits = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss;
          const py = y + (sy + 0.5) / ss;
          if (px < x0 || px > x1 || py < y0 || py > y1) continue;
          const dx = Math.max(x0 + radius - px, 0, px - (x1 - radius));
          const dy = Math.max(y0 + radius - py, 0, py - (y1 - radius));
          if (dx * dx + dy * dy > radius * radius) continue;
          hits++;
        }
      }
      if (!hits) continue;
      const coverage = hits / (ss * ss);
      const [r, g, b] = colorAt(x, y);
      blend(canvas, x, y, r, g, b, Math.round(coverage * 255));
    }
  }
}

function blend(canvas, x, y, r, g, b, a) {
  const i = (y * canvas.size + x) * 4;
  const dstA = canvas.px[i + 3] / 255;
  const srcA = a / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  canvas.px[i] = Math.round((r * srcA + canvas.px[i] * dstA * (1 - srcA)) / outA);
  canvas.px[i + 1] = Math.round((g * srcA + canvas.px[i + 1] * dstA * (1 - srcA)) / outA);
  canvas.px[i + 2] = Math.round((b * srcA + canvas.px[i + 2] * dstA * (1 - srcA)) / outA);
  canvas.px[i + 3] = Math.round(outA * 255);
}

function triangle(canvas, ax, ay, bx, by, cx, cy, color) {
  const ss = 3;
  const minX = Math.floor(Math.min(ax, bx, cx));
  const maxX = Math.ceil(Math.max(ax, bx, cx));
  const minY = Math.floor(Math.min(ay, by, cy));
  const maxY = Math.ceil(Math.max(ay, by, cy));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let hits = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss;
          const py = y + (sy + 0.5) / ss;
          const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
          const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
          const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
          const neg = d1 < 0 || d2 < 0 || d3 < 0;
          const pos = d1 > 0 || d2 > 0 || d3 > 0;
          if (!(neg && pos)) hits++;
        }
      }
      if (!hits) continue;
      blend(canvas, x, y, color[0], color[1], color[2], Math.round((hits / (ss * ss)) * 255));
    }
  }
}

function drawIcon(size) {
  const canvas = makeCanvas(size);
  const s = size;

  // 背景：蓝色渐变圆角方块
  roundedRect(canvas, s * 0.04, s * 0.04, s * 0.96, s * 0.96, s * 0.22, (x, y) => {
    const t = clamp01(y / s);
    return [
      Math.round(lerp(30, 59, t)),
      Math.round(lerp(58, 130, t)),
      Math.round(lerp(138, 246, t)),
    ];
  });

  // 白色文稿
  const pageX0 = s * 0.28;
  const pageX1 = s * 0.72;
  const pageY0 = s * 0.19;
  const pageY1 = s * 0.7;
  roundedRect(canvas, pageX0, pageY0, pageX1, pageY1, s * 0.04, () => [255, 255, 255]);

  // 文稿上的三条“文字”线（蓝色）
  const lineColor = [37, 99, 235];
  for (let i = 0; i < 3; i++) {
    const ly = pageY0 + s * (0.1 + i * 0.11);
    roundedRect(
      canvas,
      pageX0 + s * 0.06,
      ly,
      pageX1 - s * (i === 2 ? 0.15 : 0.06),
      ly + Math.max(1, s * 0.035),
      s * 0.017,
      () => lineColor,
    );
  }

  // 下载箭头（白色，压在文稿下沿、渐变背景上）
  const arrowColor = [255, 255, 255];
  roundedRect(canvas, s * 0.465, s * 0.62, s * 0.535, s * 0.79, s * 0.03, () => arrowColor);
  triangle(canvas, s * 0.36, s * 0.75, s * 0.64, s * 0.75, s * 0.5, s * 0.94, arrowColor);

  return canvas;
}

/**
 * 写出图标到目录。
 * @param {string} dir 目标目录（不存在会创建）
 * @returns {Promise<string[]>} 写出的文件路径
 */
export async function writeIcons(dir) {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  const outputs = [];
  for (const size of [16, 32, 48, 128]) {
    const { px } = drawIcon(size);
    const file = path.join(dir, `${size}.png`);
    writeFileSync(file, encodePng(size, size, px));
    outputs.push(file);
  }
  return outputs;
}

// node scripts/make-icons.mjs [目录]
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] || path.resolve(import.meta.dirname, '..', 'assets', 'icons');
  mkdirSync(dir, { recursive: true });
  const files = await writeIcons(dir);
  console.log(files.join('\n'));
}
