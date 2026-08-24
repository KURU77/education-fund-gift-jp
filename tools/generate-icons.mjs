/**
 * アイコン（SVG と PNG）をまとめて書き出す。
 *
 *   node tools/generate-icons.mjs
 *
 * 外部ライブラリは使いません。図形の定義（SHAPES）を唯一の原本として、
 * SVG の書き出しと PNG のラスタライズの両方をここで行うので、
 * 図柄を変えたいときは SHAPES だけ直してこのスクリプトを流し直します。
 *
 * 図柄は「¥」と、その下の残枠ゲージ。ゲージの左側だけが濃いのは、
 * 非課税枠を使った分と残っている分を表しています。
 * （学帽は cert-tracker が使っているので、ここでは避けています）
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(root, 'assets');
mkdirSync(assets, { recursive: true });

const BG = '#16705a';
const FG = '#ffffff';

/** 座標はすべて 0〜1 の相対値。x は左端、y は上端。描画順は後のものが上。 */
const SHAPES = [
  { type: 'roundRect', x: 0, y: 0, w: 1, h: 1, r: 0.22, color: BG, alpha: 1, bg: true },

  // ¥ の左右の払い（斜めなので polygon で描く）
  { type: 'polygon', points: [[0.292, 0.200], [0.364, 0.200], [0.536, 0.430], [0.464, 0.430]], color: FG, alpha: 1 },
  { type: 'polygon', points: [[0.708, 0.200], [0.636, 0.200], [0.464, 0.430], [0.536, 0.430]], color: FG, alpha: 1 },
  // 縦棒（下の横棒より少し下まで伸ばす）
  { type: 'roundRect', x: 0.464, y: 0.410, w: 0.072, h: 0.270, r: 0.036, color: FG, alpha: 1 },
  // 2本の横棒
  { type: 'roundRect', x: 0.325, y: 0.492, w: 0.350, h: 0.056, r: 0.028, color: FG, alpha: 1 },
  { type: 'roundRect', x: 0.325, y: 0.576, w: 0.350, h: 0.056, r: 0.028, color: FG, alpha: 1 },

  // 残枠ゲージ：全体（薄い）と使用済み（濃い）
  { type: 'roundRect', x: 0.220, y: 0.755, w: 0.560, h: 0.055, r: 0.0275, color: FG, alpha: 0.34 },
  { type: 'roundRect', x: 0.220, y: 0.755, w: 0.330, h: 0.055, r: 0.0275, color: FG, alpha: 1 },
];

// ---------- SVG ----------

const round = (n) => Math.round(n * 100) / 100;

function toSvg({ inset = 0, rounded = true } = {}) {
  const scale = 1 - inset * 2;
  const at = (v) => round((inset + v * scale) * 512);
  const len = (v) => round(v * scale * 512);

  const body = SHAPES.map((s) => {
    if (s.bg) {
      const r = rounded ? round(0.22 * 512) : 0;
      return `  <rect x="0" y="0" width="512" height="512" rx="${r}" fill="${s.color}"/>`;
    }
    if (s.type === 'polygon') {
      const pts = s.points.map(([x, y]) => `${at(x)},${at(y)}`).join(' ');
      return `  <polygon points="${pts}" fill="${s.color}" fill-opacity="${s.alpha}"/>`;
    }
    return `  <rect x="${at(s.x)}" y="${at(s.y)}" width="${len(s.w)}" height="${len(s.h)}" rx="${len(s.r)}" fill="${s.color}" fill-opacity="${s.alpha}"/>`;
  }).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="教育資金贈与マネージャー">\n${body}\n</svg>\n`;
}

// ---------- ラスタライズ ----------

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function insideRoundRect(px, py, s) {
  const { x, y, w, h, r } = s;
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const rx = Math.min(r, w / 2);
  const ry = Math.min(r, h / 2);
  // 角の内側（円の中心）からの距離だけ判定すればよい
  const cx = px < x + rx ? x + rx : px > x + w - rx ? x + w - rx : px;
  const cy = py < y + ry ? y + ry : py > y + h - ry ? y + h - ry : py;
  const dx = px - cx;
  const dy = py - cy;
  if (dx === 0 || dy === 0) return true;
  return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
}

/** 交差数え上げ（even-odd）による内外判定。 */
function insidePolygon(px, py, s) {
  const pts = s.points;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const isInside = (px, py, s) => (s.type === 'polygon' ? insidePolygon(px, py, s) : insideRoundRect(px, py, s));

/**
 * @param {number} size 出力の一辺（px）
 * @param {{inset?: number, rounded?: boolean, ss?: number}} opts
 * @returns {Buffer} RGBA のピクセル列
 */
function rasterize(size, { inset = 0, rounded = true, ss = 4 } = {}) {
  const scale = 1 - inset * 2;
  const shapes = SHAPES.map((s) => {
    if (s.bg) return { ...s, x: 0, y: 0, w: 1, h: 1, r: rounded ? 0.22 : 0, rgb: hexToRgb(s.color) };
    if (s.type === 'polygon') {
      return { ...s, points: s.points.map(([x, y]) => [inset + x * scale, inset + y * scale]), rgb: hexToRgb(s.color) };
    }
    return {
      ...s,
      x: inset + s.x * scale,
      y: inset + s.y * scale,
      w: s.w * scale,
      h: s.h * scale,
      r: s.r * scale,
      rgb: hexToRgb(s.color),
    };
  });

  const out = Buffer.alloc(size * size * 4);
  const step = 1 / (size * ss);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const ux = (px * ss + sx + 0.5) * step;
          const uy = (py * ss + sy + 0.5) * step;
          // 1サンプルぶんの色を、下から順に重ねて決める
          let cr = 0, cg = 0, cb = 0, ca = 0;
          for (const s of shapes) {
            if (!isInside(ux, uy, s)) continue;
            const sa = s.alpha;
            cr = s.rgb[0] * sa + cr * (1 - sa);
            cg = s.rgb[1] * sa + cg * (1 - sa);
            cb = s.rgb[2] * sa + cb * (1 - sa);
            ca = sa + ca * (1 - sa);
          }
          r += cr; g += cg; b += cb; a += ca;
        }
      }
      const n = ss * ss;
      const i = (py * size + px) * 4;
      const alpha = a / n;
      // 上の合成は「アルファ済みの色」なので、そのまま平均して非プリマルチに戻す
      out[i] = alpha > 0 ? Math.round(Math.min(r / n / alpha, 255)) : 0;
      out[i + 1] = alpha > 0 ? Math.round(Math.min(g / n / alpha, 255)) : 0;
      out[i + 2] = alpha > 0 ? Math.round(Math.min(b / n / alpha, 255)) : 0;
      out[i + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

// ---------- PNG 書き出し ----------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function toPng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  // 10..12 = compression / filter / interlace はすべて 0

  // 各行の先頭にフィルタ種別（0 = None）を挟む
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 実行 ----------

writeFileSync(join(assets, 'icon.svg'), toSvg());
writeFileSync(join(assets, 'icon-maskable.svg'), toSvg({ inset: 0.19, rounded: false }));

/**
 * apple-touch-icon は iOS 側で角丸に切り抜かれるうえ、透明部分が黒くなるため、
 * 角丸なし・不透明の板で書き出す。
 */
const jobs = [
  ['apple-touch-icon.png', 180, { rounded: false }],
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['favicon-32.png', 32, {}],
  ['icon-maskable-512.png', 512, { inset: 0.19, rounded: false }],
];

for (const [name, size, opts] of jobs) {
  writeFileSync(join(assets, name), toPng(rasterize(size, opts), size));
  console.log(`${name} (${size}x${size})`);
}
console.log('icon.svg / icon-maskable.svg');
