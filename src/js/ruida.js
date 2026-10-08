// Ruida controller job files (.rd) and transport framing – used by Thunder
// Laser (Nova, Bolt…) and most Chinese CO₂ lasers.
//
// Written for LaserCutX from the publicly documented Ruida protocol (as
// reverse-engineered by the MeerK40t, VisiCut/LibLaserCut and ruida-laser
// projects). Coordinates are micrometres, speeds µm/s, powers 0–100 % mapped
// to 14 bits. Every byte is "swizzled" (scrambled) with a model-specific magic
// number before it goes to the controller.
//
// This module is pure (no I/O) so it can be unit-tested.
import { flatten, applyPoint } from './geometry.js';
import { placedItems } from './exporters.js';
import { hatch } from './gcode.js';
import { laserDefaults } from './model.js';

export const MAGIC_DEFAULT = 0x88; // RDC644x (Thunder Nova); 0x11 on some 634x
export const UDP_PORT = 50200; // controller listens here
export const UDP_REPLY_PORT = 40200; // and answers here
export const UDP_CHUNK = 998; // max payload per datagram (plus 2-byte checksum)

// ---------- byte helpers ----------

export function swizzleByte(b, magic = MAGIC_DEFAULT) {
  b ^= (b >> 7) & 0xff;
  b ^= (b << 7) & 0xff;
  b ^= (b >> 7) & 0xff;
  b ^= magic;
  return (b + 1) & 0xff;
}

export function unswizzleByte(b, magic = MAGIC_DEFAULT) {
  b = (b - 1) & 0xff;
  b ^= magic;
  b ^= (b >> 7) & 0xff;
  b ^= (b << 7) & 0xff;
  b ^= (b >> 7) & 0xff;
  return b;
}

export function swizzle(bytes, magic = MAGIC_DEFAULT) {
  const lut = Array.from({ length: 256 }, (_, i) => swizzleByte(i, magic));
  return Uint8Array.from(bytes, (b) => lut[b]);
}

export function unswizzle(bytes, magic = MAGIC_DEFAULT) {
  const lut = Array.from({ length: 256 }, (_, i) => unswizzleByte(i, magic));
  return Uint8Array.from(bytes, (b) => lut[b]);
}

// 35-bit value as five 7-bit bytes, most significant first.
export function enc32(v) {
  v = Math.round(v);
  // keep two's complement for negatives within 35 bits
  const n = BigInt.asUintN(35, BigInt(v));
  const out = [];
  for (let shift = 28n; shift >= 0n; shift -= 7n) out.push(Number((n >> shift) & 0x7fn));
  return out;
}

// 14-bit value as two 7-bit bytes.
export function enc14(v) {
  v = Math.round(v) & 0x3fff;
  return [(v >> 7) & 0x7f, v & 0x7f];
}

export const encPower = (pct) => enc14((Math.max(0, Math.min(100, pct)) * 16383) / 100);
export const encCoord = (mm) => enc32(mm * 1000); // µm
export const encSpeed = (mmPerSec) => enc32(mmPerSec * 1000); // µm/s

// UDP framing: 2-byte big-endian checksum of the swizzled chunk, then the chunk.
export function udpPackets(swizzled, chunk = UDP_CHUNK) {
  const packets = [];
  for (let i = 0; i < swizzled.length; i += chunk) {
    const part = swizzled.subarray(i, i + chunk);
    let sum = 0;
    for (const b of part) sum += b;
    const pkt = new Uint8Array(part.length + 2);
    pkt[0] = (sum >> 8) & 0xff;
    pkt[1] = sum & 0xff;
    pkt.set(part, 2);
    packets.push(pkt);
  }
  return packets;
}

// Replies are single swizzled bytes: ACK (0xCC) or NAK/checksum error (0xCF).
export const ACK = 0xcc;
export const NAK = 0xcf;
export const ENQ = 0xce;

// ---------- job building ----------

// Converts a side of the project into Ruida job bytes (not yet swizzled).
// opts:
//   speedUnit   'mm/s' (Ruida) or 'mm/min' – unit of the layer speeds
//   homeCorner  'top-right' (Thunder Nova and most Ruida machines) or 'top-left'
//   startFrom   'current' (laser head position) or 'origin' (origin set on the panel)
//   frameOnly   true: trace the job's bounding box at 0 % power (placement check)
//   imageMask(el, pxPerMm) -> { mask, pxW, pxH } for raster images
//   sheet, mirror – as for the other exporters
export function buildRuidaJob(project, side, ctx, opts = {}) {
  const L = { ...laserDefaults(), ...(project.laser || {}) };
  const unit = opts.speedUnit || L.machine?.speedUnit || 'mm/s';
  const mmPerSec = (v) => (unit === 'mm/min' ? v / 60 : v);
  const { items } = placedItems(project, side, ctx, opts);

  // ---- gather polylines per layer (in design mm, y down) ----
  const parts = []; // { name, speed, power, passes, polys: [{points, closed}] }
  const addPart = (name, set, polys) => {
    if (!set.output || !polys.length) return;
    parts.push({ name, speed: mmPerSec(set.speed), power: set.power, passes: Math.max(1, Math.round(set.passes || 1)), polys });
  };

  if (!opts.frameOnly) {
    // raster images as scan lines
    const imgPolys = [];
    for (const it of items.filter((i) => i.raster && i.op !== 'cut')) {
      const m = opts.imageMask ? opts.imageMask(it.el, 1 / Math.max(0.02, L.image.interval || 0.1)) : null;
      if (!m) continue;
      for (let row = 0; row < m.pxH; row++) {
        const ly = ((row + 0.5) / m.pxH) * it.h;
        for (let c = 0; c < m.pxW; ) {
          if (!m.mask[row * m.pxW + c]) {
            c++;
            continue;
          }
          const s0 = c;
          while (c < m.pxW && m.mask[row * m.pxW + c]) c++;
          let a = applyPoint(it.matrix, (s0 / m.pxW) * it.w, ly);
          let b = applyPoint(it.matrix, (c / m.pxW) * it.w, ly);
          if (row % 2) [a, b] = [b, a];
          imgPolys.push({ points: [a, b], closed: false });
        }
      }
    }
    addPart('Images', L.image, imgPolys);

    // filled engraving as hatch lines
    const fillPolys = [];
    for (const it of items.filter((i) => i.op === 'engrave' && i.cmds)) {
      for (const [x0, y, x1] of hatch(it.cmds, L.engrave.interval || 0.1, it.fillRule, L.engrave.bidirectional !== false)) {
        fillPolys.push({ points: [[x0, y], [x1, y]], closed: false });
      }
    }
    addPart('Fill', L.engrave, fillPolys);

    const lines = items.filter((i) => i.op === 'score' && i.cmds).flatMap((i) => flatten(i.cmds, 0.02));
    addPart('Line', L.score, lines);

    // cuts: inner shapes first, outlines last
    const cuts = items
      .filter((i) => i.op === 'cut' && i.cmds)
      .map((i) => ({ i, polys: flatten(i.cmds, 0.02) }))
      .map((c) => ({ ...c, area: bboxOf(c.polys.flatMap((p) => p.points)).area }))
      .sort((a, b) => (a.i.outline ? 1 : 0) - (b.i.outline ? 1 : 0) || a.area - b.area)
      .flatMap((c) => c.polys);
    addPart('Cut', L.cut, cuts);
  }

  // job bounds (design mm)
  const allPts = parts.flatMap((p) => p.polys.flatMap((q) => q.points));
  if (opts.frameOnly || !allPts.length) {
    const b = bboxOf(items.flatMap((i) => (i.cmds ? flatten(i.cmds, 0.1).flatMap((q) => q.points) : rasterCorners(i))));
    if (!isFinite(b.minX)) return { bytes: new Uint8Array(0), bounds: null, parts: [] };
    if (opts.frameOnly) {
      const frame = [
        [b.minX, b.minY],
        [b.maxX, b.minY],
        [b.maxX, b.maxY],
        [b.minX, b.maxY],
      ];
      parts.length = 0;
      parts.push({ name: 'Frame', speed: Math.min(100, mmPerSec(L.machine?.travel || 100)), power: 0, passes: 1, polys: [{ points: frame, closed: true }] });
    }
  }
  const pts = parts.flatMap((p) => p.polys.flatMap((q) => q.points));
  const B = bboxOf(pts);
  if (!pts.length) return { bytes: new Uint8Array(0), bounds: null, parts: [] };

  // ---- design mm -> device mm (relative to the job's start corner) ----
  // Device axes point away from the home corner; the start point (laser head
  // or panel origin) becomes the job corner nearest home.
  const right = (opts.homeCorner || 'top-right').endsWith('right');
  const dev = ([x, y]) => [right ? B.maxX - x : x - B.minX, y - B.minY];
  const W = B.maxX - B.minX;
  const H = B.maxY - B.minY;

  const out = [];
  const put = (...bytes) => {
    for (const b of bytes) out.push(...(Array.isArray(b) ? b : [b]));
  };
  const point = (cmd, p) => {
    const [x, y] = dev(p);
    put(cmd, encCoord(x), encCoord(y));
  };

  // ---- header ----
  put(0xd8, opts.startFrom === 'origin' ? 0x11 : 0x12); // reference: anchor/origin or current position
  put(0xe6, 0x01); // absolute coordinates within the job
  put(0xf0); // reference point set
  put(0xf1, 0x02, 0x00); // block cutting off
  put(0xd8, 0x00); // start process
  put(0xe7, 0x06, enc32(0), enc32(0)); // feed repeat
  put(0xe7, 0x38, 0x00); // feed auto pause off
  put(0xe7, 0x03, encCoord(0), encCoord(0)); // process top-left
  put(0xe7, 0x07, encCoord(W), encCoord(H)); // process bottom-right
  put(0xe7, 0x50, encCoord(0), encCoord(0)); // document min
  put(0xe7, 0x51, encCoord(W), encCoord(H)); // document max
  put(0xe7, 0x04, enc14(1), enc14(1), enc14(0), enc14(0), enc14(0), enc14(0), enc14(0)); // process repeat 1×
  put(0xe7, 0x05, 0x00); // array direction

  const partBounds = parts.map((p) => {
    const b = bboxOf(p.polys.flatMap((q) => q.points).map(dev));
    return b;
  });
  parts.forEach((p, i) => {
    const b = partBounds[i];
    put(0xc9, 0x04, i, encSpeed(p.speed));
    put(0xc6, 0x31, i, encPower(p.power));
    put(0xc6, 0x32, i, encPower(p.power));
    put(0xc6, 0x41, i, encPower(p.power));
    put(0xc6, 0x42, i, encPower(p.power));
    put(0xca, 0x06, i, enc32(LAYER_COLORS[i % LAYER_COLORS.length]));
    put(0xca, 0x41, i, 0x00); // work mode: vector
    put(0xe7, 0x52, i, encCoord(b.minX), encCoord(b.minY));
    put(0xe7, 0x53, i, encCoord(b.maxX), encCoord(b.maxY));
    put(0xe7, 0x61, i, encCoord(b.minX), encCoord(b.minY));
    put(0xe7, 0x62, i, encCoord(b.maxX), encCoord(b.maxY));
  });
  put(0xca, 0x22, Math.max(0, parts.length - 1)); // last layer index

  // ---- layers ----
  let travel = 0;
  parts.forEach((p, i) => {
    put(0xca, 0x01, 0x00); // work mode
    put(0xca, 0x02, i); // layer number
    put(0xca, 0x01, 0x10); // laser 1
    put(0xca, 0x01, 0x13); // air assist on (CO₂ needs it for clean marks and cuts)
    put(0xc9, 0x02, encSpeed(p.speed));
    put(0xc6, 0x12, enc32(0)); // laser on delay
    put(0xc6, 0x13, enc32(0)); // laser off delay
    put(0xc6, 0x01, encPower(p.power));
    put(0xc6, 0x02, encPower(p.power));
    put(0xc6, 0x21, encPower(p.power));
    put(0xc6, 0x22, encPower(p.power));
    put(0xca, 0x03, 0x01); // enable tube
    put(0xca, 0x10, 0x00);
    let last = null;
    for (let pass = 0; pass < p.passes; pass++) {
      for (const poly of p.polys) {
        const ptsOf = poly.closed ? [...poly.points, poly.points[0]] : poly.points;
        point(0x88, ptsOf[0]); // move (laser off)
        if (last) travel += Math.hypot(ptsOf[0][0] - last[0], ptsOf[0][1] - last[1]);
        for (let k = 1; k < ptsOf.length; k++) {
          point(0xa8, ptsOf[k]); // cut / mark (laser on)
          travel += Math.hypot(ptsOf[k][0] - ptsOf[k - 1][0], ptsOf[k][1] - ptsOf[k - 1][1]);
        }
        last = ptsOf[ptsOf.length - 1];
      }
    }
    put(0xe7, 0x00); // block end
    put(0xca, 0x01, 0x00); // layer end
    put(0xca, 0x01, 0x30);
  });

  // ---- tail: file checksum, end of file ----
  const sum = out.reduce((a, b) => a + b, 0) + 0xd7;
  put(0xe5, 0x05, enc32(sum));
  put(0xd7);

  return {
    bytes: Uint8Array.from(out),
    bounds: { w: W, h: H, startCorner: right ? 'top-right' : 'top-left' },
    parts: parts.map((p) => ({ name: p.name, speed: p.speed, power: p.power, passes: p.passes, paths: p.polys.length })),
    travelMm: Math.round(travel),
  };
}

const LAYER_COLORS = [0x000000, 0xff0000, 0x0000ff, 0x00a000]; // as stored by RDWorks (BGR)

function bboxOf(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, area: (maxX - minX) * (maxY - minY) };
}

function rasterCorners(it) {
  if (!it.raster) return [];
  return [
    [0, 0],
    [it.w, 0],
    [it.w, it.h],
    [0, it.h],
  ].map(([x, y]) => applyPoint(it.matrix, x, y));
}
