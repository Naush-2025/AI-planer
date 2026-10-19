'use strict';

/**
 * 生成应用图标：icon.png (256x256)、tray.png (32x32)、icon.ico。
 * 纯 Node 实现 PNG 编码，无外部依赖。图标样式：蓝色圆底 + 白色对勾。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- PNG 编码 ----------
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
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // raw scanlines，每行前加 filter byte 0
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- 像素绘制 ----------
function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.46; // 圆形半径

  // 对勾线段（相对坐标，按 size 缩放）
  const pts = [
    { x: 0.30 * size, y: 0.52 * size },
    { x: 0.45 * size, y: 0.67 * size },
    { x: 0.72 * size, y: 0.34 * size }
  ];
  const stroke = Math.max(2, size * 0.085);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      let inCircle = dist <= r;
      // 抗锯齿边缘
      let alpha = 1;
      if (inCircle && dist > r - 1.5) alpha = Math.max(0, r - dist + 0.5);

      let rCol = 0x2f, gCol = 0x7b, bCol = 0xf5, aCol = Math.round(alpha * 255); // 蓝色 #2F7BF5

      if (inCircle) {
        // 白色对勾
        if (pointOnPolyline(x, y, pts, stroke)) {
          rCol = 0xff;
          gCol = 0xff;
          bCol = 0xff;
        }
      } else {
        rCol = gCol = bCol = 0;
        aCol = 0;
      }

      rgba[i] = rCol;
      rgba[i + 1] = gCol;
      rgba[i + 2] = bCol;
      rgba[i + 3] = aCol;
    }
  }
  return rgba;
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx;
  const qy = ay + t * dy;
  return Math.hypot(px - qx, py - qy);
}

function pointOnPolyline(x, y, pts, stroke) {
  for (let i = 0; i < pts.length - 1; i++) {
    if (segDist(x, y, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y) <= stroke / 2) return true;
  }
  return false;
}

// ---------- ICO 封装（内嵌 256x256 PNG） ----------
function encodeIco(pngBuf, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count

  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; // width (0 = 256)
  entry[1] = size >= 256 ? 0 : size; // height
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(pngBuf.length, 8); // bytes in res
  entry.writeUInt32LE(22, 12); // offset

  return Buffer.concat([header, entry, pngBuf]);
}

// ---------- 输出 ----------
const assetsDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(assetsDir, { recursive: true });

const png256 = encodePng(256, 256, drawIcon(256));
const png32 = encodePng(32, 32, drawIcon(32));
const png16 = encodePng(16, 16, drawIcon(16));

fs.writeFileSync(path.join(assetsDir, 'icon.png'), png256);
fs.writeFileSync(path.join(assetsDir, 'tray.png'), png32);
fs.writeFileSync(path.join(assetsDir, 'tray-16.png'), png16);
fs.writeFileSync(path.join(assetsDir, 'icon.ico'), encodeIco(png256, 256));

console.log('图标已生成到 assets/ ：icon.png (256), tray.png (32), tray-16.png (16), icon.ico');
