// Browser-side image helpers: loading, applying erase boxes, tracing images to
// vectors, rasterising SVG to PNG and importing SVG logos.
import { multiply, invert, parseSvgPath, rectPath, ellipsePath, transformPath, pathBounds } from './geometry.js';
import { elementMatrix } from './model.js';
import { traceMask, loopsToPath, maskFromRGBA } from './trace.js';

const cache = new Map(); // src -> HTMLImageElement (loaded)

export function loadImage(src) {
  if (cache.has(src)) return Promise.resolve(cache.get(src));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      cache.set(src, img);
      resolve(img);
    };
    img.onerror = () => reject(new Error('Could not load image'));
    img.src = src;
  });
}

export const loadedImage = (src) => cache.get(src) || null;

export async function preloadImages(project) {
  const srcs = [];
  for (const side of Object.values(project.sides)) for (const el of side) if (el.type === 'image' && el.src) srcs.push(el.src);
  await Promise.all(srcs.map((s) => loadImage(s).catch(() => null)));
}

// Draws an image element into a canvas of pxW × pxH pixels with every erase box
// on the same side painted white on top.
function drawWithErase(el, eraseBoxes, pxW, pxH) {
  const img = loadedImage(el.src);
  const canvas = document.createElement('canvas');
  canvas.width = pxW;
  canvas.height = pxH;
  const g = canvas.getContext('2d');
  if (!img) return canvas;
  g.drawImage(img, 0, 0, pxW, pxH);
  if (eraseBoxes.length) {
    const toLocal = invert(elementMatrix(el, el.w, el.h));
    const sx = pxW / el.w;
    const sy = pxH / el.h;
    g.fillStyle = '#ffffff';
    for (const er of eraseBoxes) {
      if (er.hidden) continue;
      const m = multiply([sx, 0, 0, sy, 0, 0], multiply(toLocal, elementMatrix(er, er.w, er.h)));
      g.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
      g.fillRect(0, 0, er.w, er.h);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
  return canvas;
}

const eraseOn = (els) => els.filter((e) => e.type === 'erase');

// Returns a PNG data URL of the image with erase boxes applied (or the
// original if no erase boxes exist on that side).
export function bakedImageSrc(el, sideElements) {
  const boxes = eraseOn(sideElements);
  const img = loadedImage(el.src);
  if (!boxes.length || !img) return el.src;
  const maxPx = 3000;
  const k = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
  const pxW = Math.max(1, Math.round(img.naturalWidth * k));
  const pxH = Math.max(1, Math.round(img.naturalHeight * k));
  return drawWithErase(el, boxes, pxW, pxH).toDataURL('image/png');
}

// Black/white preview + trace of an image element.
// opts: { threshold 0-255, invert, pxPerMm }
export function thresholdCanvas(el, sideElements, opts) {
  const pxW = Math.max(1, Math.round(el.w * opts.pxPerMm));
  const pxH = Math.max(1, Math.round(el.h * opts.pxPerMm));
  const canvas = drawWithErase(el, eraseOn(sideElements), pxW, pxH);
  const g = canvas.getContext('2d');
  const data = g.getImageData(0, 0, pxW, pxH);
  const mask = maskFromRGBA(data.data, pxW, pxH, opts);
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i] ? 0 : 255;
    data.data[i * 4] = data.data[i * 4 + 1] = data.data[i * 4 + 2] = v;
    data.data[i * 4 + 3] = 255;
  }
  g.putImageData(data, 0, 0);
  return { canvas, mask, pxW, pxH };
}

export function traceImage(el, sideElements, opts) {
  const { mask, pxW, pxH } = thresholdCanvas(el, sideElements, opts);
  const loops = traceMask(mask, pxW, pxH, { minArea: opts.minArea ?? 3, smooth: 0.75 });
  const cmds = loopsToPath(loops, 1).map((c) => (c.type === 'Z' ? c : { ...c, x: (c.x * el.w) / pxW, y: (c.y * el.h) / pxH }));
  return { cmds, loops: loops.length };
}

// Renders an SVG string to PNG bytes at the given DPI, embedding the DPI so
// laser software imports it at the right physical size.
export async function svgToPng(svg, widthMm, heightMm, dpi) {
  const pxW = Math.round((widthMm / 25.4) * dpi);
  const pxH = Math.round((heightMm / 25.4) * dpi);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Could not render PNG'));
      i.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = pxW;
    canvas.height = pxH;
    const g = canvas.getContext('2d');
    g.drawImage(img, 0, 0, pxW, pxH);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    return setPngDpi(new Uint8Array(await blob.arrayBuffer()), dpi);
  } finally {
    URL.revokeObjectURL(url);
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Inserts a pHYs chunk right after IHDR.
export function setPngDpi(png, dpi) {
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // 'pHYs'
  dv.setUint32(8, ppm);
  dv.setUint32(12, ppm);
  chunk[16] = 1; // metres
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  const ihdrEnd = 8 + 8 + 13 + 4;
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, ihdrEnd), 0);
  out.set(chunk, ihdrEnd);
  out.set(png.subarray(ihdrEnd), ihdrEnd + chunk.length);
  return out;
}

// Imports an SVG file's shapes as one combined outline path.
// Returns { paths, bounds, fillRule, skippedText } or throws.
export function importSvg(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) {
    throw new Error('This file is not a valid SVG.');
  }
  root.querySelectorAll('script, foreignObject').forEach((n) => n.remove());
  const host = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  host.setAttribute('style', 'position:absolute;left:-99999px;top:0;width:10px;height:10px;opacity:0;pointer-events:none');
  const node = document.importNode(root, true);
  for (const n of [node, ...node.querySelectorAll('*')]) {
    for (const a of [...n.attributes]) if (/^on/i.test(a.name)) n.removeAttribute(a.name);
  }
  host.appendChild(node);
  document.body.appendChild(host);
  try {
    const base = invert(ctmOf(node));
    const cmds = [];
    let evenodd = false;
    const skip = 'defs, clipPath, mask, symbol, marker, pattern';
    const shapes = node.querySelectorAll('path, rect, circle, ellipse, polygon, polyline, line');
    for (const s of shapes) {
      if (s.closest(skip)) continue;
      const cs = getComputedStyle(s);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (cs.fillRule === 'evenodd') evenodd = true;
      const local = shapeToPath(s);
      if (!local.length) continue;
      cmds.push(...transformPath(local, multiply(base, ctmOf(s))));
    }
    const skippedText = node.querySelectorAll('text').length > 0;
    if (!cmds.length) throw new Error('No shapes found in this SVG. Convert text to paths in your design app first.');
    return { paths: cmds, bounds: pathBounds(cmds), fillRule: evenodd ? 'evenodd' : 'nonzero', skippedText };
  } finally {
    host.remove();
  }
}

function ctmOf(el) {
  const m = el.getCTM();
  return m ? [m.a, m.b, m.c, m.d, m.e, m.f] : [1, 0, 0, 1, 0, 0];
}

function shapeToPath(s) {
  const n = (a) => parseFloat(s.getAttribute(a)) || 0;
  switch (s.nodeName.toLowerCase()) {
    case 'path':
      return parseSvgPath(s.getAttribute('d') || '');
    case 'rect': {
      const rx = n('rx') || n('ry');
      return rectPath(n('x'), n('y'), n('width'), n('height'), rx);
    }
    case 'circle':
      return ellipsePath(n('cx'), n('cy'), n('r'), n('r'));
    case 'ellipse':
      return ellipsePath(n('cx'), n('cy'), n('rx'), n('ry'));
    case 'polygon':
    case 'polyline': {
      const nums = (s.getAttribute('points') || '').trim().split(/[\s,]+/).map(parseFloat);
      const out = [];
      for (let i = 0; i + 1 < nums.length; i += 2) out.push({ type: i ? 'L' : 'M', x: nums[i], y: nums[i + 1] });
      if (s.nodeName.toLowerCase() === 'polygon' && out.length) out.push({ type: 'Z' });
      return out;
    }
    case 'line':
      return [
        { type: 'M', x: n('x1'), y: n('y1') },
        { type: 'L', x: n('x2'), y: n('y2') },
      ];
    default:
      return [];
  }
}
