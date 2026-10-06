// Pure vector-geometry helpers. All coordinates are in millimetres, y pointing down.
//
// A "path" is an array of commands, always absolute:
//   { type: 'M', x, y } | { type: 'L', x, y } |
//   { type: 'C', x1, y1, x2, y2, x, y } | { type: 'Z' }
// Quadratic curves and arcs are converted to cubics on the way in, so every
// exporter only needs to understand these four commands.

// ---------- affine matrices [a, b, c, d, e, f] (same layout as SVG) ----------

export const IDENTITY = [1, 0, 0, 1, 0, 0];

export function multiply(m, n) {
  // returns m · n  (apply n first, then m)
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export const translate = (tx, ty) => [1, 0, 0, 1, tx, ty];
export const scale = (sx, sy = sx) => [sx, 0, 0, sy, 0, 0];
export function rotate(deg, cx = 0, cy = 0) {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const m = [cos, sin, -sin, cos, 0, 0];
  return multiply(translate(cx, cy), multiply(m, translate(-cx, -cy)));
}

export function compose(...ms) {
  // compose(a, b, c) applies c first, then b, then a
  return ms.reduce((acc, m) => multiply(acc, m), IDENTITY);
}

export function applyPoint(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return IDENTITY.slice();
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

export function transformPath(cmds, m) {
  return cmds.map((c) => {
    if (c.type === 'Z') return { type: 'Z' };
    const [x, y] = applyPoint(m, c.x, c.y);
    if (c.type === 'C') {
      const [x1, y1] = applyPoint(m, c.x1, c.y1);
      const [x2, y2] = applyPoint(m, c.x2, c.y2);
      return { type: 'C', x1, y1, x2, y2, x, y };
    }
    return { type: c.type, x, y };
  });
}

// ---------- shape builders ----------

const KAPPA = 0.5522847498307936; // cubic approximation of a quarter circle

export function rectPath(x, y, w, h, r = 0) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (r <= 0) {
    return [
      { type: 'M', x, y },
      { type: 'L', x: x + w, y },
      { type: 'L', x: x + w, y: y + h },
      { type: 'L', x, y: y + h },
      { type: 'Z' },
    ];
  }
  const k = r * KAPPA;
  const x2 = x + w;
  const y2 = y + h;
  return [
    { type: 'M', x: x + r, y },
    { type: 'L', x: x2 - r, y },
    { type: 'C', x1: x2 - r + k, y1: y, x2: x2, y2: y + r - k, x: x2, y: y + r },
    { type: 'L', x: x2, y: y2 - r },
    { type: 'C', x1: x2, y1: y2 - r + k, x2: x2 - r + k, y2: y2, x: x2 - r, y: y2 },
    { type: 'L', x: x + r, y: y2 },
    { type: 'C', x1: x + r - k, y1: y2, x2: x, y2: y2 - r + k, x, y: y2 - r },
    { type: 'L', x, y: y + r },
    { type: 'C', x1: x, y1: y + r - k, x2: x + r - k, y2: y, x: x + r, y },
    { type: 'Z' },
  ];
}

export function ellipsePath(cx, cy, rx, ry) {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return [
    { type: 'M', x: cx + rx, y: cy },
    { type: 'C', x1: cx + rx, y1: cy + ky, x2: cx + kx, y2: cy + ry, x: cx, y: cy + ry },
    { type: 'C', x1: cx - kx, y1: cy + ry, x2: cx - rx, y2: cy + ky, x: cx - rx, y: cy },
    { type: 'C', x1: cx - rx, y1: cy - ky, x2: cx - kx, y2: cy - ry, x: cx, y: cy - ry },
    { type: 'C', x1: cx + kx, y1: cy - ry, x2: cx + rx, y2: cy - ky, x: cx + rx, y: cy },
    { type: 'Z' },
  ];
}

// Converts opentype.js path commands (M/L/Q/C/Z) to our command set.
export function fromOpentype(commands) {
  const out = [];
  let cx = 0;
  let cy = 0;
  for (const c of commands) {
    if (c.type === 'M' || c.type === 'L') {
      out.push({ type: c.type, x: c.x, y: c.y });
      cx = c.x;
      cy = c.y;
    } else if (c.type === 'Q') {
      out.push(quadToCubic(cx, cy, c.x1, c.y1, c.x, c.y));
      cx = c.x;
      cy = c.y;
    } else if (c.type === 'C') {
      out.push({ type: 'C', x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2, x: c.x, y: c.y });
      cx = c.x;
      cy = c.y;
    } else if (c.type === 'Z') {
      out.push({ type: 'Z' });
    }
  }
  return out;
}

function quadToCubic(x0, y0, qx, qy, x, y) {
  return {
    type: 'C',
    x1: x0 + (2 / 3) * (qx - x0),
    y1: y0 + (2 / 3) * (qy - y0),
    x2: x + (2 / 3) * (qx - x),
    y2: y + (2 / 3) * (qy - y),
    x,
    y,
  };
}

// ---------- SVG path data parsing (for importing vector logos) ----------

export function parseSvgPath(d) {
  const tokens = String(d).match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
  const out = [];
  let i = 0;
  let cmd = '';
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let lastC = null; // last cubic control point (for S)
  let lastQ = null; // last quadratic control point (for T)
  const num = () => parseFloat(tokens[i++]);
  const isNum = () => i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i]);

  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i])) cmd = tokens[i++];
    else if (!cmd) break;
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    let nextC = null;
    let nextQ = null;

    if (C === 'Z') {
      out.push({ type: 'Z' });
      cx = sx;
      cy = sy;
      cmd = '';
      // a number directly after Z is invalid; skip to the next command letter
      while (isNum()) i++;
      lastC = lastQ = null;
      continue;
    }
    if (!isNum()) {
      cmd = '';
      continue;
    }
    if (C === 'M') {
      cx = ox + num();
      cy = oy + num();
      sx = cx;
      sy = cy;
      out.push({ type: 'M', x: cx, y: cy });
      cmd = rel ? 'l' : 'L'; // subsequent pairs are implicit line-tos
    } else if (C === 'L') {
      cx = ox + num();
      cy = oy + num();
      out.push({ type: 'L', x: cx, y: cy });
    } else if (C === 'H') {
      cx = ox + num();
      out.push({ type: 'L', x: cx, y: cy });
    } else if (C === 'V') {
      cy = oy + num();
      out.push({ type: 'L', x: cx, y: cy });
    } else if (C === 'C') {
      const x1 = ox + num();
      const y1 = oy + num();
      const x2 = ox + num();
      const y2 = oy + num();
      cx = ox + num();
      cy = oy + num();
      out.push({ type: 'C', x1, y1, x2, y2, x: cx, y: cy });
      nextC = [x2, y2];
    } else if (C === 'S') {
      const x1 = lastC ? 2 * cx - lastC[0] : cx;
      const y1 = lastC ? 2 * cy - lastC[1] : cy;
      const x2 = ox + num();
      const y2 = oy + num();
      cx = ox + num();
      cy = oy + num();
      out.push({ type: 'C', x1, y1, x2, y2, x: cx, y: cy });
      nextC = [x2, y2];
    } else if (C === 'Q') {
      const qx = ox + num();
      const qy = oy + num();
      const x = ox + num();
      const y = oy + num();
      out.push(quadToCubic(cx, cy, qx, qy, x, y));
      cx = x;
      cy = y;
      nextQ = [qx, qy];
    } else if (C === 'T') {
      const qx = lastQ ? 2 * cx - lastQ[0] : cx;
      const qy = lastQ ? 2 * cy - lastQ[1] : cy;
      const x = ox + num();
      const y = oy + num();
      out.push(quadToCubic(cx, cy, qx, qy, x, y));
      cx = x;
      cy = y;
      nextQ = [qx, qy];
    } else if (C === 'A') {
      const rx = num();
      const ry = num();
      const rot = num();
      const large = num();
      const sweep = num();
      const x = ox + num();
      const y = oy + num();
      out.push(...arcToCubics(cx, cy, rx, ry, rot, large, sweep, x, y));
      cx = x;
      cy = y;
    } else {
      i++; // unknown command: skip a token to avoid an infinite loop
    }
    lastC = nextC;
    lastQ = nextQ;
  }
  return out;
}

// SVG elliptical arc → cubic beziers (W3C implementation notes, F.6).
export function arcToCubics(x1, y1, rx, ry, phiDeg, fa, fs, x2, y2) {
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return [{ type: 'L', x: x2, y: y2 }];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const sign = fa === fs ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux, uy, vx, vy) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dtheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dtheta > 0) dtheta -= 2 * Math.PI;
  if (fs && dtheta < 0) dtheta += 2 * Math.PI;

  const segs = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2)));
  const delta = dtheta / segs;
  const t = (4 / 3) * Math.tan(delta / 4);
  const out = [];
  let th = theta1;
  const pt = (a) => {
    const ex = rx * Math.cos(a);
    const ey = ry * Math.sin(a);
    return [cos * ex - sin * ey + cx, sin * ex + cos * ey + cy];
  };
  const deriv = (a) => {
    const ex = -rx * Math.sin(a);
    const ey = ry * Math.cos(a);
    return [cos * ex - sin * ey, sin * ex + cos * ey];
  };
  for (let s = 0; s < segs; s++) {
    const p0 = pt(th);
    const d0 = deriv(th);
    const th2 = th + delta;
    const p3 = pt(th2);
    const d3 = deriv(th2);
    out.push({
      type: 'C',
      x1: p0[0] + t * d0[0],
      y1: p0[1] + t * d0[1],
      x2: p3[0] - t * d3[0],
      y2: p3[1] - t * d3[1],
      x: p3[0],
      y: p3[1],
    });
    th = th2;
  }
  // snap the final point exactly onto the requested end point
  const last = out[out.length - 1];
  last.x = x2;
  last.y = y2;
  return out;
}

// ---------- output ----------

const fmt = (n, p) => {
  const s = n.toFixed(p);
  return s.indexOf('.') >= 0 ? s.replace(/\.?0+$/, '') || '0' : s;
};

export function toSvgD(cmds, precision = 4) {
  const f = (n) => fmt(n, precision);
  let d = '';
  for (const c of cmds) {
    if (c.type === 'M') d += `M${f(c.x)} ${f(c.y)}`;
    else if (c.type === 'L') d += `L${f(c.x)} ${f(c.y)}`;
    else if (c.type === 'C') d += `C${f(c.x1)} ${f(c.y1)} ${f(c.x2)} ${f(c.y2)} ${f(c.x)} ${f(c.y)}`;
    else if (c.type === 'Z') d += 'Z';
  }
  return d;
}

// Splits a path into polylines, approximating curves within `tolerance` mm.
export function flatten(cmds, tolerance = 0.01) {
  const polys = [];
  let cur = null;
  let cx = 0;
  let cy = 0;
  for (const c of cmds) {
    if (c.type === 'M') {
      if (cur && cur.points.length > 1) polys.push(cur);
      cur = { points: [[c.x, c.y]], closed: false };
      cx = c.x;
      cy = c.y;
    } else if (c.type === 'L') {
      if (!cur) cur = { points: [[cx, cy]], closed: false };
      cur.points.push([c.x, c.y]);
      cx = c.x;
      cy = c.y;
    } else if (c.type === 'C') {
      if (!cur) cur = { points: [[cx, cy]], closed: false };
      const n = cubicSegments(cx, cy, c, tolerance);
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const mt = 1 - t;
        const a = mt * mt * mt;
        const b = 3 * mt * mt * t;
        const d = 3 * mt * t * t;
        const e = t * t * t;
        cur.points.push([
          a * cx + b * c.x1 + d * c.x2 + e * c.x,
          a * cy + b * c.y1 + d * c.y2 + e * c.y,
        ]);
      }
      cx = c.x;
      cy = c.y;
    } else if (c.type === 'Z') {
      if (cur) {
        cur.closed = true;
        const [fx, fy] = cur.points[0];
        const [lx, ly] = cur.points[cur.points.length - 1];
        if (cur.points.length > 1 && Math.abs(fx - lx) < 1e-9 && Math.abs(fy - ly) < 1e-9) cur.points.pop();
        if (cur.points.length > 1) polys.push(cur);
        cx = fx;
        cy = fy;
        cur = null;
      }
    }
  }
  if (cur && cur.points.length > 1) polys.push(cur);
  return polys;
}

function cubicSegments(x0, y0, c, tol) {
  // Bound on the second derivative gives the number of segments needed.
  const ddx = Math.max(Math.abs(x0 - 2 * c.x1 + c.x2), Math.abs(c.x1 - 2 * c.x2 + c.x));
  const ddy = Math.max(Math.abs(y0 - 2 * c.y1 + c.y2), Math.abs(c.y1 - 2 * c.y2 + c.y));
  const dd = Math.hypot(ddx, ddy) * 6;
  const n = Math.ceil(Math.sqrt(dd / (8 * tol)));
  return Math.max(1, Math.min(200, n));
}

export function pathBounds(cmds) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of flatten(cmds, 0.05)) {
    for (const [x, y] of poly.points) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (minX === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
