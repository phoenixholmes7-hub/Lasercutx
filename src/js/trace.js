// Bitmap → vector tracing. Turns a black/white mask into closed outlines that
// follow pixel edges, so an imported picture (logo, card artwork) becomes a
// real vector shape that SVG and DXF exports can carry.

// mask: Uint8Array of width*height, 1 = dark (engrave), 0 = light.
// Returns an array of loops; each loop is an array of [x, y] grid corners.
// Outer outlines and holes have opposite winding, so the nonzero fill rule
// renders them correctly.
// `smooth` (in pixels) straightens pixel stair-steps; 0 keeps exact pixel edges.
export function traceMask(mask, width, height, { minArea = 2, smooth = 0 } = {}) {
  const W1 = width + 1;
  const dark = (x, y) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;
  const out = new Map(); // vertex index -> array of next vertex indices
  const add = (x0, y0, x1, y1) => {
    const a = y0 * W1 + x0;
    const list = out.get(a);
    if (list) list.push(y1 * W1 + x1);
    else out.set(a, [y1 * W1 + x1]);
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!dark(x, y)) continue;
      if (!dark(x, y - 1)) add(x, y, x + 1, y);
      if (!dark(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!dark(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!dark(x - 1, y)) add(x, y + 1, x, y);
    }
  }

  const loops = [];
  for (const [start, nexts] of out) {
    while (nexts.length) {
      const loop = [start];
      let cur = nexts.pop();
      let guard = 0;
      while (cur !== start && guard++ < 1e7) {
        loop.push(cur);
        const list = out.get(cur);
        if (!list || !list.length) break;
        cur = list.pop();
      }
      let pts = simplify(loop.map((v) => [v % W1, Math.floor(v / W1)]));
      if (smooth > 0 && pts.length > 8) pts = simplifyClosed(pts, smooth);
      if (pts.length >= 3 && Math.abs(area(pts)) >= minArea) loops.push(pts);
    }
  }
  return loops;
}

// Drops points that lie on a straight line between their neighbours.
function simplify(pts) {
  const n = pts.length;
  if (n < 4) return pts;
  const res = [];
  for (let i = 0; i < n; i++) {
    const [ax, ay] = pts[(i - 1 + n) % n];
    const [bx, by] = pts[i];
    const [cx, cy] = pts[(i + 1) % n];
    if ((bx - ax) * (cy - by) - (by - ay) * (cx - bx) !== 0) res.push(pts[i]);
  }
  return res;
}

// Douglas–Peucker for a closed loop: split at the point farthest from the
// first one and simplify both halves.
function simplifyClosed(pts, tol) {
  let far = 0;
  let best = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const a = dp(pts.slice(0, far + 1), tol);
  const b = dp([...pts.slice(far), pts[0]], tol);
  const res = [...a.slice(0, -1), ...b.slice(0, -1)];
  return res.length >= 3 ? res : pts;
}

function dp(pts, tol) {
  if (pts.length < 3) return pts;
  const [ax, ay] = pts[0];
  const [bx, by] = pts[pts.length - 1];
  const len = Math.hypot(bx - ax, by - ay) || 1e-9;
  let idx = 0;
  let max = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
    if (d > max) {
      max = d;
      idx = i;
    }
  }
  if (max <= tol) return [pts[0], pts[pts.length - 1]];
  const left = dp(pts.slice(0, idx + 1), tol);
  const right = dp(pts.slice(idx), tol);
  return [...left.slice(0, -1), ...right];
}

function area(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % n];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

// Converts loops to path commands, scaling pixels to millimetres.
export function loopsToPath(loops, mmPerPx) {
  const cmds = [];
  for (const loop of loops) {
    loop.forEach(([x, y], i) => cmds.push({ type: i ? 'L' : 'M', x: x * mmPerPx, y: y * mmPerPx }));
    cmds.push({ type: 'Z' });
  }
  return cmds;
}

// Builds a mask from RGBA pixels. Transparent pixels count as light.
export function maskFromRGBA(data, width, height, { threshold = 128, invert = false } = {}) {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const a = data[i * 4 + 3] / 255;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) * a + 255 * (1 - a);
    let isDark = lum < threshold;
    if (invert && a > 0.01) isDark = !isDark;
    mask[i] = isDark ? 1 : 0;
  }
  return mask;
}
