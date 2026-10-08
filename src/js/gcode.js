// G-code for GRBL-based diode / CO2 lasers (LightBurn-style output):
// raster images, then filled engraving (scanline hatch), then line engraving,
// then cuts – inner shapes before outer ones so parts don't drop early.
import { flatten, pathBounds, applyPoint } from './geometry.js';
import { placedItems } from './exporters.js';
import { laserDefaults } from './model.js';
import { toMmPerMin } from './machines.js';

const f3 = (n) => (Math.round(n * 1000) / 1000).toString();

// opts: { sheet, mirror, imageMask(el, pxPerMm) -> { mask, pxW, pxH } | null }
export function toGcode(project, side, ctx, opts = {}) {
  const L = { ...laserDefaults(), ...(project.laser || {}) };
  const M = L.machine;
  const unit = M.speedUnit || 'mm/min';
  const feed = (v) => toMmPerMin(v, unit); // G-code F is always mm/min
  const { layout, items } = placedItems(project, side, ctx, opts);
  const H = layout.h;
  const lines = [];
  let cut = 0; // mm with laser on
  let travel = 0; // mm with laser off
  let time = 0; // seconds
  let pos = [0, 0];
  const S = (pct) => Math.round((Math.max(0, Math.min(100, pct)) / 100) * M.maxS);

  const moveTo = (x, y) => {
    const d = Math.hypot(x - pos[0], y - pos[1]);
    if (d < 1e-4) return;
    travel += d;
    time += (d / feed(M.travel)) * 60;
    lines.push(`G0 X${f3(x)} Y${f3(H - y)}`);
    pos = [x, y];
  };
  const burnTo = (x, y, set) => {
    const d = Math.hypot(x - pos[0], y - pos[1]);
    if (d < 1e-4) return;
    cut += d;
    time += (d / feed(set.speed)) * 60;
    lines.push(`G1 X${f3(x)} Y${f3(H - y)} S${S(set.power)} F${Math.round(feed(set.speed))}`);
    pos = [x, y];
  };
  const comment = (t) => lines.push(`; ${t}`);

  lines.push('; LaserCutX G-code (GRBL)', `; Sheet ${f3(layout.w)} x ${f3(H)} mm, origin bottom-left`, 'G21', 'G90', `${M.laserMode || 'M4'} S0`);
  if (M.airAssist) lines.push('M8');

  // ---- raster images ----
  const img = L.image;
  if (img.output) {
    for (const it of items.filter((i) => i.raster && i.op !== 'cut')) {
      const pxPerMm = 1 / Math.max(0.02, img.interval);
      const m = opts.imageMask ? opts.imageMask(it.el, pxPerMm) : null;
      if (!m) continue;
      comment(`Image: ${it.el.name || 'image'}`);
      for (let pass = 0; pass < img.passes; pass++) {
        for (let row = 0; row < m.pxH; row++) {
          const ly = ((row + 0.5) / m.pxH) * it.h;
          const runs = [];
          for (let c = 0; c < m.pxW; ) {
            if (!m.mask[row * m.pxW + c]) {
              c++;
              continue;
            }
            const s0 = c;
            while (c < m.pxW && m.mask[row * m.pxW + c]) c++;
            runs.push([(s0 / m.pxW) * it.w, (c / m.pxW) * it.w]);
          }
          if (row % 2) runs.reverse().forEach((r) => r.reverse());
          for (const [a, b] of runs) {
            const [x0, y0] = applyPoint(it.matrix, a, ly);
            const [x1, y1] = applyPoint(it.matrix, b, ly);
            moveTo(x0, y0);
            burnTo(x1, y1, img);
          }
        }
      }
    }
  }

  // ---- filled engraving ----
  const fill = L.engrave;
  if (fill.output) {
    for (const it of items.filter((i) => i.op === 'engrave' && i.cmds)) {
      comment(`Fill: ${it.el.name || it.el.type}`);
      const segs = hatch(it.cmds, fill.interval, it.fillRule, fill.bidirectional !== false);
      for (let pass = 0; pass < fill.passes; pass++) {
        for (const [x0, y, x1] of segs) {
          moveTo(x0, y);
          burnTo(x1, y, fill);
        }
      }
    }
  }

  // ---- vector outlines ----
  const trace = (it, set) => {
    comment(`${it.op === 'cut' ? 'Cut' : 'Line'}: ${it.el.name || it.el.type}`);
    const polys = flatten(it.cmds, 0.02);
    for (let pass = 0; pass < set.passes; pass++) {
      for (const p of polys) {
        moveTo(...p.points[0]);
        for (let i = 1; i < p.points.length; i++) burnTo(...p.points[i], set);
        if (p.closed) burnTo(...p.points[0], set);
      }
    }
  };
  if (L.score.output) for (const it of items.filter((i) => i.op === 'score' && i.cmds)) trace(it, L.score);
  if (L.cut.output) {
    const cuts = items
      .filter((i) => i.op === 'cut' && i.cmds)
      .map((i) => ({ i, a: areaOf(i.cmds), outline: i.outline ? 1 : 0 }))
      .sort((p, q) => p.outline - q.outline || p.a - q.a); // inner first, outlines last
    for (const { i } of cuts) trace(i, L.cut);
  }

  lines.push('M5 S0');
  if (M.airAssist) lines.push('M9');
  lines.push('G0 X0 Y0', 'M2');
  return { gcode: lines.join('\n') + '\n', stats: { seconds: Math.round(time), cutMm: Math.round(cut), travelMm: Math.round(travel), lines: lines.length } };
}

function areaOf(cmds) {
  const b = pathBounds(cmds);
  return b.w * b.h;
}

// Scanline fill. Returns [x0, y, x1] segments, alternating direction when
// bidirectional. Handles holes with nonzero or even-odd rules.
export function hatch(cmds, interval, fillRule = 'nonzero', bidirectional = true) {
  const polys = flatten(cmds, Math.min(0.02, interval / 4)).filter((p) => p.points.length > 2);
  const edges = [];
  for (const p of polys) {
    const pts = p.points;
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % pts.length];
      if (y0 === y1) continue;
      edges.push(y0 < y1 ? { ya: y0, yb: y1, xa: x0, xb: x1, dir: 1 } : { ya: y1, yb: y0, xa: x1, xb: x0, dir: -1 });
    }
  }
  if (!edges.length) return [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (const e of edges) {
    minY = Math.min(minY, e.ya);
    maxY = Math.max(maxY, e.yb);
  }
  const out = [];
  let flip = false;
  for (let y = minY + interval / 2; y < maxY; y += interval) {
    const xs = [];
    for (const e of edges) {
      if (y < e.ya || y >= e.yb) continue;
      xs.push({ x: e.xa + ((y - e.ya) / (e.yb - e.ya)) * (e.xb - e.xa), dir: e.dir });
    }
    xs.sort((a, b) => a.x - b.x);
    const spans = [];
    let wind = 0;
    for (let i = 0; i < xs.length - 1; i++) {
      wind += fillRule === 'evenodd' ? 1 : xs[i].dir;
      const inside = fillRule === 'evenodd' ? wind % 2 === 1 : wind !== 0;
      if (inside && xs[i + 1].x - xs[i].x > 1e-6) {
        const last = spans[spans.length - 1];
        if (last && Math.abs(last[1] - xs[i].x) < 1e-6) last[1] = xs[i + 1].x;
        else spans.push([xs[i].x, xs[i + 1].x]);
      }
    }
    if (bidirectional && flip) spans.reverse().forEach((s) => s.reverse());
    for (const [a, b] of spans) out.push([a, y, b]);
    if (spans.length) flip = !flip;
  }
  return out;
}
