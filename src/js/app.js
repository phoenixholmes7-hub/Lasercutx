// LaserCutX editor UI.
import * as opentype from '../vendor/opentype.mjs';
import qrcode from '../vendor/qrcode.mjs';
import { toSvgD, invert, applyPoint, rectPath, ellipsePath, pathBounds } from './geometry.js';
import {
  CARD_PRESETS,
  OPS,
  MATERIALS,
  FONTS,
  FORMATS,
  TEMPLATES,
  PT_TO_MM,
  newProject,
  newId,
  formatText,
  elementGeometry,
  applyPreset,
  laserDefaults,
  makeText,
  makeRect,
  makeEllipse,
  makeChip,
  makeQr,
  makeImage,
  makeVector,
  makeErase,
  makeChipArt,
  makeContactless,
  makePolygon,
  makeStar,
} from './model.js';
import { toSVG, toDXF, toRasterSVG, sheetLayout, outlinePath } from './exporters.js';
import { toGcode } from './gcode.js';
import * as platform from './platform.js';
import * as claude from './claude.js';
import { Grbl, serialSupported } from './machine.js';
import {
  loadImage,
  preloadImages,
  bakedImageSrc,
  processedImageSrc,
  thresholdCanvas,
  traceImage,
  svgToPng,
  importSvg,
  engraveMask,
  cropImage,
  imageForAi,
} from './imaging.js';

// qrcode-generator only handles Latin-1 by default; encode text as UTF-8.
qrcode.stringToBytes = (s) => Array.from(new TextEncoder().encode(s));

const $ = (s) => document.querySelector(s);
const OP_LABELS = { ...Object.fromEntries(Object.entries(OPS).map(([k, v]) => [k, v.label])), none: 'Guide only (not exported)' };

const state = {
  project: newProject('blank'), // the start screen picks what to make
  side: 'front',
  sel: new Set(), // selected element ids
  zoom: 8, // screen px per mm
  fonts: {}, // file/custom key -> opentype.Font
  undo: [],
  redo: [],
  lastChangeKey: null,
  lastChangeAt: 0,
  dirty: false,
  trace: { threshold: 128, invert: false, pxPerMm: 12 },
  tool: 'select',
  snap: 0.1,
  grid: false,
  clipboard: null,
  pen: null, // { points: [[x,y]...] } while drawing with the pen
  cursor: null,
  aiSignedIn: false,
};

// ---------- fonts ----------

async function loadBuiltInFonts() {
  const jobs = [];
  for (const f of FONTS) {
    for (const file of Object.values(f.files)) {
      jobs.push(
        fetch(`vendor/fonts/${file}`)
          .then((r) => r.arrayBuffer())
          .then((buf) => (state.fonts[file] = opentype.parse(buf)))
          .catch((e) => console.error('font', file, e))
      );
    }
  }
  await Promise.all(jobs);
}

function loadCustomFonts() {
  for (const cf of state.project.customFonts || []) {
    if (state.fonts[cf.key]) continue;
    try {
      const bin = Uint8Array.from(atob(cf.data), (c) => c.charCodeAt(0));
      state.fonts[cf.key] = opentype.parse(bin.buffer);
    } catch (e) {
      console.error('custom font', cf.label, e);
    }
  }
}

function getFont(key, weight) {
  if (key && key.startsWith('custom:')) return state.fonts[key] || null;
  const f = FONTS.find((x) => x.key === key) || FONTS[0];
  return state.fonts[f.files[weight] || f.files[400]] || null;
}

const ctx = { getFont, qrcode };

// ---------- helpers ----------

const els = () => state.project.sides[state.side];
const selectedEls = () => els().filter((e) => state.sel.has(e.id));
const selected = () => (state.sel.size === 1 ? selectedEls()[0] || null : null);
const card = () => state.project.card;
const round = (n, p = 2) => Math.round(n * 10 ** p) / 10 ** p;
const pad = () => Math.max(6, Math.min(card().w, card().h) * 0.06); // workspace margin in mm
const isCard = () => (card().kind || 'card') === 'card';
const ui = (k) => 8 / state.zoom * k; // screen-constant sizes in mm

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

function busy(text) {
  $('#busyText').textContent = text || '';
  $('#busy').classList.toggle('show', !!text);
}

// Records an undo step. Consecutive changes with the same key within a second
// (e.g. typing in a field) become one step.
function checkpoint(key = null) {
  const now = Date.now();
  if (key && key === state.lastChangeKey && now - state.lastChangeAt < 1000) {
    state.lastChangeAt = now;
    return;
  }
  state.undo.push(JSON.stringify(state.project));
  if (state.undo.length > 100) state.undo.shift();
  state.redo = [];
  state.lastChangeKey = key;
  state.lastChangeAt = now;
  state.dirty = true;
}

function undo() {
  if (!state.undo.length) return;
  state.redo.push(JSON.stringify(state.project));
  state.project = JSON.parse(state.undo.pop());
  state.lastChangeKey = null;
  renderAll();
}

function redo() {
  if (!state.redo.length) return;
  state.undo.push(JSON.stringify(state.project));
  state.project = JSON.parse(state.redo.pop());
  state.lastChangeKey = null;
  renderAll();
}

const snapV = (v) => (state.snap ? Math.round(v / state.snap) * state.snap : v);

// Axis-aligned bounds of an element on the workspace.
function worldBox(el, geo = elementGeometry(el, ctx)) {
  const pts = [
    [0, 0],
    [geo.w, 0],
    [geo.w, geo.h],
    [0, geo.h],
  ].map(([x, y]) => applyPoint(geo.matrix, x, y));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

function unionBox(list) {
  if (!list.length) return null;
  const bs = list.map((e) => worldBox(e));
  const x = Math.min(...bs.map((b) => b.x));
  const y = Math.min(...bs.map((b) => b.y));
  return { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y };
}

// Clicking one member of a group selects the whole group.
function withGroup(ids) {
  const out = new Set(ids);
  for (const el of els()) {
    if (el.group && [...ids].some((id) => els().find((e) => e.id === id)?.group === el.group)) out.add(el.id);
  }
  return out;
}

// ---------- rendering: stage ----------

function renderStage() {
  const c = card();
  const mat = MATERIALS[c.material] || MATERIALS.silver;
  const svg = $('#stage');
  const P = pad();
  const W = c.w + P * 2;
  const H = c.h + P * 2;
  svg.setAttribute('viewBox', `${-P} ${-P} ${W} ${H}`);
  svg.setAttribute('width', Math.round(W * state.zoom));
  svg.setAttribute('height', Math.round(H * state.zoom));
  $('#zoomLabel').textContent = `${Math.round((state.zoom / 8) * 100)}%`;
  svg.style.cursor = state.tool === 'select' ? 'default' : 'crosshair';

  const outline = toSvgD(outlinePath(c));
  const images = [];
  const erases = [];
  const vectors = [];
  const hits = [];
  let selBox = '';
  const sel = selectedEls();

  for (const el of els()) {
    const geo = elementGeometry(el, ctx);
    const m = geo.matrix.map((n) => round(n, 5)).join(' ');
    const guide = el.op === 'none';
    if (!el.hidden) {
      if (geo.raster) {
        if (geo.raster.src) {
          const src = processedImageSrc(el, els(), 1200);
          // engraved look: dark pixels in the mark colour, light pixels show the material
          images.push(
            `<image href="${src}" x="0" y="0" width="${geo.w}" height="${geo.h}" preserveAspectRatio="none" transform="matrix(${m})" opacity="${guide ? 0.45 : 1}" filter="url(#${guide ? 'gray' : 'engr'})"/>`
          );
        }
      } else if (el.type === 'erase') {
        erases.push(
          `<rect x="0" y="0" width="${geo.w}" height="${geo.h}" transform="matrix(${m})" fill="url(#mat)" stroke="#ff9f1a" stroke-width="${ui(0.12)}" stroke-dasharray="${ui(0.6)} ${ui(0.4)}"/>`
        );
      } else if (geo.cmds.length) {
        const d = toSvgD(geo.cmds, 3);
        const o = guide ? ' opacity="0.35"' : '';
        if (el.op === 'cut') {
          vectors.push(`<path d="${d}" fill="#0b0c0e" fill-opacity="0.8" stroke="#ff3b30" stroke-width="${ui(0.15)}" stroke-dasharray="${ui(0.8)} ${ui(0.4)}"${o}/>`);
        } else if (el.op === 'score' || (el.type === 'vector' && el.open)) {
          vectors.push(`<path d="${d}" fill="none" stroke="${mat.mark}" stroke-width="${Math.max(0.1, ui(0.18))}"${o}/>`);
        } else {
          vectors.push(`<path d="${d}" fill="${mat.mark}" fill-rule="${geo.fillRule}"${o}/>`);
        }
      }
    }
    hits.push(
      `<rect class="hit" data-id="${el.id}" x="0" y="0" width="${Math.max(geo.w, ui(1))}" height="${Math.max(geo.h, ui(1))}" transform="matrix(${m})" fill="transparent" style="cursor:${el.locked ? 'not-allowed' : 'move'}"/>`
    );
    if (state.sel.has(el.id)) {
      selBox += `<rect x="0" y="0" width="${geo.w}" height="${geo.h}" transform="matrix(${m})" fill="none" stroke="${el.locked ? '#ff9f1a' : '#3d8bfd'}" stroke-width="${ui(0.12)}" stroke-dasharray="${ui(0.6)} ${ui(0.3)}" pointer-events="none"/>`;
      if (sel.length === 1 && !el.locked) {
        const hs = ui(1.6);
        const [hx, hy] = applyPoint(geo.matrix, geo.w, geo.h);
        const [tx, ty] = applyPoint(geo.matrix, geo.w / 2, 0);
        const [rx, ry] = applyPoint(geo.matrix, geo.w / 2, -ui(5) / Math.max(0.01, Math.hypot(geo.matrix[2], geo.matrix[3])));
        selBox += `<line x1="${tx}" y1="${ty}" x2="${rx}" y2="${ry}" stroke="#3d8bfd" stroke-width="${ui(0.12)}" pointer-events="none"/>
          <circle class="rothandle" cx="${rx}" cy="${ry}" r="${hs / 1.6}" fill="#fff" stroke="#3d8bfd" stroke-width="${ui(0.15)}" style="cursor:grab"><title>Drag to rotate (Shift = 15° steps)</title></circle>
          <rect class="handle" x="${hx - hs / 2}" y="${hy - hs / 2}" width="${hs}" height="${hs}" fill="#fff" stroke="#3d8bfd" stroke-width="${ui(0.15)}" style="cursor:nwse-resize"/>`;
      }
    }
  }
  if (sel.length > 1) {
    const u = unionBox(sel);
    selBox += `<rect x="${u.x}" y="${u.y}" width="${u.w}" height="${u.h}" fill="none" stroke="#3d8bfd" stroke-width="${ui(0.15)}" pointer-events="none"/>`;
  }

  // grid
  let grid = '';
  if (state.grid) {
    const step = state.snap >= 1 ? state.snap : state.zoom > 12 ? 1 : 5;
    const lines = [];
    for (let x = 0; x <= c.w + 1e-6; x += step) lines.push(`M${round(x, 3)} 0V${c.h}`);
    for (let y = 0; y <= c.h + 1e-6; y += step) lines.push(`M0 ${round(y, 3)}H${c.w}`);
    grid = `<path d="${lines.join('')}" stroke="#3d8bfd" stroke-opacity="0.18" stroke-width="${ui(0.06)}" pointer-events="none"/>`;
  }

  // drawing previews
  let drawing = '';
  if (drag?.mode === 'marquee' && drag.box) {
    const b = drag.box;
    drawing += `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#3d8bfd22" stroke="#3d8bfd" stroke-width="${ui(0.1)}" pointer-events="none"/>`;
  }
  if (drag?.mode === 'draw' && drag.box) {
    const b = drag.box;
    const d = drag.kind === 'ellipse' ? toSvgD(ellipsePath(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2)) : toSvgD(rectPath(b.x, b.y, b.w, b.h));
    drawing += `<path d="${d}" fill="none" stroke="#3d8bfd" stroke-width="${ui(0.15)}" pointer-events="none"/>`;
  }
  if (state.pen?.points.length) {
    const pts = [...state.pen.points, ...(state.cursor ? [state.cursor] : [])];
    drawing += `<polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="#3d8bfd" stroke-width="${ui(0.15)}" pointer-events="none"/>`;
    for (const [x, y] of state.pen.points) drawing += `<circle cx="${x}" cy="${y}" r="${ui(0.5)}" fill="#3d8bfd" pointer-events="none"/>`;
  }

  const safe = 2.5;
  const safeArea =
    isCard() && c.shape !== 'ellipse'
      ? `<rect x="${safe}" y="${safe}" width="${c.w - 2 * safe}" height="${c.h - 2 * safe}" fill="none" stroke="#3d8bfd" stroke-opacity="0.35" stroke-width="${ui(0.08)}" stroke-dasharray="${ui(1)} ${ui(0.6)}" rx="${Math.max(0, c.radius - safe)}" pointer-events="none"/>`
      : '';
  svg.innerHTML = `
    <defs>
      <linearGradient id="mat" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${mat.base2}"/><stop offset="0.55" stop-color="${mat.base}"/><stop offset="1" stop-color="${mat.base2}"/>
      </linearGradient>
      <clipPath id="cardClip"><path d="${outline}"/></clipPath>
      <filter id="gray"><feColorMatrix type="saturate" values="0"/></filter>
      <filter id="engr" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="0 0 0 0 ${hexRgb(mat.mark)[0]} 0 0 0 0 ${hexRgb(mat.mark)[1]} 0 0 0 0 ${hexRgb(mat.mark)[2]} -0.299 -0.587 -0.114 1 0"/></filter>
    </defs>
    <rect class="bg" x="${-P}" y="${-P}" width="${W}" height="${H}" fill="transparent"/>
    <path class="bg" d="${outline}" fill="url(#mat)" stroke="${c.includeOutline ? '#ff3b30' : '#0006'}" stroke-width="${ui(0.15)}" style="filter:drop-shadow(0 0.6px 1.2px #0008)"/>
    ${grid}
    ${safeArea}
    <g clip-path="url(#cardClip)">${images.join('')}${erases.join('')}</g>
    <g>${vectors.join('')}</g>
    <g>${hits.join('')}</g>
    ${selBox}
    ${drawing}`;
  renderStatus();
}

const hexRgb = (hex) => [1, 3, 5].map((i) => round(parseInt(hex.slice(i, i + 2), 16) / 255, 3));

function renderStatus() {
  const parts = [];
  if (state.cursor) parts.push(`X ${state.cursor[0].toFixed(1)}  Y ${state.cursor[1].toFixed(1)} mm`);
  const sel = selectedEls();
  if (sel.length) {
    const u = unionBox(sel);
    parts.push(`${sel.length > 1 ? `${sel.length} items · ` : ''}${u.w.toFixed(1)} × ${u.h.toFixed(1)} mm`);
  }
  $('#status').textContent = parts.join('   ·   ');
  const hints = {
    select: 'Click to select · Shift-click to add · drag empty space to box-select · Space-drag or middle-drag to pan · scroll to zoom',
    pen: 'Pen: click to add points · click the first point to close · double-click or Enter to finish · Esc to cancel',
    rect: 'Drag to draw a rectangle (Shift = square)',
    ellipse: 'Drag to draw an ellipse (Shift = circle)',
  };
  $('#hint').textContent = hints[state.tool];
}

// ---------- rendering: layers ----------

function renderLayers() {
  const ul = $('#layerList');
  const list = [...els()].reverse();
  if (!list.length) {
    ul.innerHTML = '<li class="empty" style="color:var(--muted);cursor:default">Nothing here yet – use Add, the drawing tools, or paste an image.</li>';
    return;
  }
  ul.innerHTML = list
    .map((el) => {
      const color = el.type === 'erase' ? '#ff9f1a' : OPS[el.op]?.color || '#777';
      const label = el.name || el.type;
      return `<li data-id="${el.id}" class="${state.sel.has(el.id) ? 'sel' : ''} ${el.hidden ? 'hidden' : ''}">
        <span class="dot" style="background:${color}"></span>
        <span class="nm" title="${escapeHtml(label)}">${escapeHtml(label)}${el.group ? ' <span class="grp">▣</span>' : ''}</span>
        <button class="lock" data-lock="${el.id}" title="Lock / unlock">${el.locked ? '🔒' : '🔓'}</button>
        <button class="eye" data-eye="${el.id}" title="Show / hide">${el.hidden ? '◌' : '●'}</button></li>`;
    })
    .join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// ---------- rendering: quick fill ----------

function renderQuickFill() {
  const box = $('#quickFill');
  box.innerHTML = '';
  let any = false;
  for (const side of ['front', 'back']) {
    const fields = state.project.sides[side].filter((e) => e.type === 'text' || e.type === 'qr');
    if (!fields.length) continue;
    any = true;
    const title = document.createElement('div');
    title.className = 'side-title';
    title.textContent = side === 'front' ? 'Front' : 'Back';
    box.appendChild(title);
    for (const el of fields) {
      const label = document.createElement('label');
      label.textContent = el.type === 'qr' ? `${el.name || 'QR code'} (link / text)` : el.name || 'Text';
      const value = el.type === 'qr' ? el.data : el.text;
      const multi = el.type === 'text' && value.includes('\n');
      const input = document.createElement(multi ? 'textarea' : 'input');
      input.value = value;
      if (multi) input.rows = value.split('\n').length;
      input.addEventListener('focus', () => {
        if (state.side !== side || selected()?.id !== el.id) {
          state.side = side;
          state.sel = new Set([el.id]);
          syncSideToggle();
          renderStage();
          renderLayers();
          renderProps();
        }
      });
      input.addEventListener('input', () => {
        checkpoint(`qf-${el.id}`);
        if (el.type === 'qr') el.data = input.value;
        else el.text = formatText(el.format, input.value);
        refresh();
      });
      input.addEventListener('change', () => {
        if (el.type === 'text') input.value = el.text; // show the formatted value
      });
      label.appendChild(input);
      box.appendChild(label);
    }
  }
  if (!any) box.innerHTML = '<div class="empty">Add a text or QR code and it will appear here for quick editing.</div>';
}

// ---------- properties panel helpers ----------

function field(parent, label, value, onInput, opts = {}) {
  const l = document.createElement('label');
  l.textContent = label;
  let input;
  if (opts.options) {
    input = document.createElement('select');
    for (const [v, t] of Object.entries(opts.options)) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = t;
      if (String(v) === String(value)) o.selected = true;
      input.appendChild(o);
    }
  } else if (opts.textarea) {
    input = document.createElement('textarea');
    input.value = value ?? '';
    input.rows = Math.max(2, String(value ?? '').split('\n').length);
  } else {
    input = document.createElement('input');
    input.type = opts.type || 'text';
    if (opts.step) input.step = opts.step;
    if (opts.min !== undefined) input.min = opts.min;
    if (opts.max !== undefined) input.max = opts.max;
    if (input.type === 'checkbox') {
      input.checked = !!value;
      l.className = 'check';
      l.textContent = '';
      l.appendChild(input);
      l.appendChild(document.createTextNode(' ' + label));
    } else {
      input.value = typeof value === 'number' ? round(value, 3) : value ?? '';
    }
  }
  if (input.type !== 'checkbox') l.appendChild(input);
  const ev = input.tagName === 'SELECT' || input.type === 'checkbox' ? 'change' : 'input';
  input.addEventListener(ev, () => {
    let v = input.type === 'checkbox' ? input.checked : input.value;
    if (opts.type === 'number' || opts.type === 'range') {
      v = parseFloat(v);
      if (!Number.isFinite(v)) return;
    }
    onInput(v, input);
  });
  parent.appendChild(l);
  return input;
}

function row(parent) {
  const d = document.createElement('div');
  d.className = 'row';
  parent.appendChild(d);
  return d;
}

function buttons(parent, list, cls) {
  const d = document.createElement('div');
  d.className = `btnrow ${cls || ''}`;
  for (const [text, fn, bcls, title] of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    if (bcls) b.className = bcls;
    if (title) b.title = title;
    b.addEventListener('click', fn);
    d.appendChild(b);
  }
  parent.appendChild(d);
  return d;
}

function heading(parent, text, sub) {
  const h = document.createElement('h2');
  h.textContent = text;
  if (sub) h.className = 'sub';
  parent.appendChild(h);
}

function tip(parent, html) {
  const d = document.createElement('div');
  d.className = 'tip';
  d.innerHTML = html;
  parent.appendChild(d);
}

// Updates an element property with undo + re-render.
const setter = (el, key, after) => (v) => {
  checkpoint(`${el.id}-${key}`);
  el[key] = v;
  if (after) after(v);
  refresh();
};

// ---------- properties panel ----------

function renderProps() {
  const p = $('#props');
  p.innerHTML = '';
  const sel = selectedEls();
  if (!sel.length) return renderWorkspaceProps(p);
  if (sel.length > 1) return renderMultiProps(p, sel);
  const el = sel[0];
  const typeNames = { qr: 'QR code', erase: 'Erase box', vector: 'Vector shape', polygon: el.star ? 'Star' : 'Polygon' };
  heading(p, `${typeNames[el.type] || el.type[0].toUpperCase() + el.type.slice(1)} properties`);
  field(p, 'Name', el.name, setter(el, 'name', () => renderQuickFill()));

  if (el.type !== 'erase') field(p, 'Laser operation', el.op, setter(el, 'op'), { options: { ...OP_LABELS } });

  if (el.type === 'text') renderTextProps(p, el);
  if (el.type === 'qr') {
    field(p, 'QR content (link, text, phone…)', el.data, setter(el, 'data', () => renderQuickFill()), { textarea: true });
    field(p, 'Error correction', el.ecl, setter(el, 'ecl'), { options: { L: 'Low (7%)', M: 'Medium (15%)', Q: 'Quartile (25%)', H: 'High (30%)' } });
  }
  if (el.type === 'polygon') {
    const r = row(p);
    field(r, el.star ? 'Points' : 'Sides', el.sides, setter(el, 'sides'), { type: 'number', step: 1, min: 3, max: 64 });
    field(r, 'Star', el.star, setter(el, 'star', () => renderProps()), { type: 'checkbox' });
    if (el.star) field(p, `Inner radius (${Math.round((el.inner || 0.5) * 100)}%)`, el.inner, setter(el, 'inner'), { type: 'range', min: 0.1, max: 0.9, step: 0.01 });
  }

  const geo = elementGeometry(el, ctx);
  const r = row(p);
  field(r, el.anchor === 'center' ? 'X centre (mm)' : 'X (mm)', el.x, setter(el, 'x'), { type: 'number', step: 0.1 });
  field(r, 'Y (mm)', el.y, setter(el, 'y'), { type: 'number', step: 0.1 });
  if (el.type === 'text') {
    tip(p, `Size: ${round(geo.w)} × ${round(geo.h)} mm`);
  } else {
    const r2 = row(p);
    const keepAspect = el.type === 'image' || el.type === 'vector';
    field(r2, el.type === 'qr' ? 'Size (mm)' : 'Width (mm)', el.w, (v) => {
      checkpoint(`${el.id}-w`);
      if (keepAspect && el.w) el.h = (el.h * v) / el.w;
      el.w = v;
      if (el.type === 'qr') el.h = v;
      refresh();
    }, { type: 'number', step: 0.1, min: 0.1 });
    if (el.type !== 'qr') {
      field(r2, 'Height (mm)', el.h, (v) => {
        checkpoint(`${el.id}-h`);
        if (keepAspect && el.h) el.w = (el.w * v) / el.h;
        el.h = v;
        refresh();
      }, { type: 'number', step: 0.1, min: 0.1 });
    }
  }
  const r3 = row(p);
  field(r3, 'Rotation (°)', el.rotation || 0, setter(el, 'rotation'), { type: 'number', step: 1 });
  if (el.type === 'rect') field(r3, 'Corner radius', el.radius || 0, setter(el, 'radius'), { type: 'number', step: 0.1, min: 0 });

  renderArrangeTools(p, [el]);

  if (el.type === 'image') renderImageTools(p, el);
  if (el.type === 'vector') {
    field(p, 'Fill rule', el.fillRule || 'nonzero', setter(el, 'fillRule'), { options: { nonzero: 'Non-zero', evenodd: 'Even-odd (fixes filled holes)' } });
  }
  if (el.type === 'erase') {
    tip(p, 'An <b>Erase box</b> whites-out the part of any image underneath it – use it to hide an old name or card number, then type the new one with a Text item on top. It is applied when you trace or export the image and is never cut or engraved itself.');
  }
}

function renderTextProps(p, el) {
  field(p, 'Text', el.text, (v) => setter(el, 'text')(formatText(el.format, v)), { textarea: true });
  field(p, 'Quick Fill format', el.format || 'none', setter(el, 'format', () => (el.text = formatText(el.format, el.text))), {
    options: Object.fromEntries(Object.entries(FORMATS).map(([k, f]) => [k, f.label])),
  });
  const fontOpts = Object.fromEntries(FONTS.map((f) => [f.key, f.label]));
  for (const cf of state.project.customFonts || []) fontOpts[cf.key] = `${cf.label} (custom)`;
  fontOpts.__load = '＋ Load font file (TTF/OTF/WOFF)…';
  field(p, 'Font', el.font, async (v, input) => {
    if (v === '__load') {
      input.value = el.font;
      const key = await loadFontFile();
      if (key) {
        setter(el, 'font')(key);
        renderProps();
      }
      return;
    }
    setter(el, 'font')(v);
  }, { options: fontOpts });
  const r1 = row(p);
  field(r1, 'Size (pt)', el.sizePt, setter(el, 'sizePt'), { type: 'number', step: 0.5, min: 1 });
  field(r1, 'Bold', el.weight >= 700, (v) => setter(el, 'weight')(v ? 700 : 400), { type: 'checkbox' });
  const r2 = row(p);
  field(r2, 'Letter spacing (mm)', el.letterSpacing, setter(el, 'letterSpacing'), { type: 'number', step: 0.1 });
  field(r2, 'Line height', el.lineHeight, setter(el, 'lineHeight'), { type: 'number', step: 0.05, min: 0.5 });
  field(p, 'Align', el.align, setter(el, 'align'), { options: { left: 'Left', center: 'Center', right: 'Right' } });
  field(p, 'Curve text – bend radius in mm (0 = straight, negative = curve down)', el.arc || 0, setter(el, 'arc'), { type: 'number', step: 1 });
  field(p, 'Keep centred when text changes (X = centre)', el.anchor === 'center', (v) => {
    checkpoint();
    const g = elementGeometry(el, ctx);
    // convert X so the text does not jump
    if (v && el.anchor !== 'center') el.x = round(el.x + g.w / 2, 3);
    if (!v && el.anchor === 'center') el.x = round(el.x - g.w / 2, 3);
    el.anchor = v ? 'center' : undefined;
    refresh();
    renderProps();
  }, { type: 'checkbox' });
}

// Align / flip / order / array / group / lock tools for one or more items.
function renderArrangeTools(p, list) {
  const single = list.length === 1;
  heading(p, single ? 'Arrange (to workspace)' : 'Align & distribute', true);
  buttons(
    p,
    [
      ['⇤', () => align('left'), null, 'Align left'],
      ['↔', () => align('hcenter'), null, 'Centre horizontally'],
      ['⇥', () => align('right'), null, 'Align right'],
      ['⤒', () => align('top'), null, 'Align top'],
      ['↕', () => align('vcenter'), null, 'Centre vertically'],
      ['⤓', () => align('bottom'), null, 'Align bottom'],
    ],
    'align'
  );
  if (list.length > 2) buttons(p, [['Distribute ↔', () => distribute('x')], ['Distribute ↕', () => distribute('y')]]);
  buttons(p, [
    ['Flip ⇋', () => flip('x'), null, 'Mirror horizontally'],
    ['Flip ⇵', () => flip('y'), null, 'Mirror vertically'],
    ['Forward', () => reorder(1)],
    ['Back', () => reorder(-1)],
  ]);
  const grouped = list.some((e) => e.group);
  buttons(p, [
    ...(list.length > 1 ? [['Group', groupSelected, null, 'Ctrl/Cmd+G']] : []),
    ...(grouped ? [['Ungroup', ungroupSelected, null, 'Ctrl/Cmd+Shift+G']] : []),
    [list.every((e) => e.locked) ? 'Unlock' : 'Lock', toggleLock],
    ['Duplicate', duplicate, null, 'Ctrl/Cmd+D'],
  ]);
  buttons(p, [
    [`To ${state.side === 'front' ? 'back' : 'front'} side`, moveToOtherSide],
    ['Delete', removeSelected, 'danger'],
  ]);
  renderArrayTool(p);
}

function renderArrayTool(p) {
  heading(p, 'Array (repeat copies)', true);
  const a = (state.arrayOpts ||= { mode: 'grid', cols: 3, rows: 2, gapX: 2, gapY: 2, count: 8, radius: 20, rotate: true });
  field(p, 'Type', a.mode, (v) => {
    a.mode = v;
    renderProps();
  }, { options: { grid: 'Grid (rows × columns)', circle: 'Circular (around a centre)' } });
  if (a.mode === 'grid') {
    const r = row(p);
    field(r, 'Columns', a.cols, (v) => (a.cols = v), { type: 'number', min: 1, step: 1 });
    field(r, 'Rows', a.rows, (v) => (a.rows = v), { type: 'number', min: 1, step: 1 });
    const r2 = row(p);
    field(r2, 'Gap X (mm)', a.gapX, (v) => (a.gapX = v), { type: 'number', step: 0.5 });
    field(r2, 'Gap Y (mm)', a.gapY, (v) => (a.gapY = v), { type: 'number', step: 0.5 });
  } else {
    const r = row(p);
    field(r, 'Copies', a.count, (v) => (a.count = v), { type: 'number', min: 2, step: 1 });
    field(r, 'Radius (mm)', a.radius, (v) => (a.radius = v), { type: 'number', min: 1, step: 0.5 });
    field(p, 'Rotate copies to face the centre', a.rotate, (v) => (a.rotate = v), { type: 'checkbox' });
  }
  buttons(p, [['Create array', makeArray, 'primary']]);
}

function renderMultiProps(p, sel) {
  heading(p, `${sel.length} items selected`);
  field(p, 'Laser operation (all)', sel.every((e) => e.op === sel[0].op) ? sel[0].op : '', (v) => {
    if (!v) return;
    checkpoint();
    for (const e of sel) if (e.type !== 'erase') e.op = v;
    refresh();
  }, { options: { '': '— mixed —', ...OP_LABELS } });
  field(p, 'Scale selection (%)', 100, (v, input) => {
    if (v <= 0 || v === 100) return;
    checkpoint();
    scaleSelection(v / 100);
    input.value = 100;
    refresh();
  }, { type: 'number', step: 5, min: 1 });
  renderArrangeTools(p, sel);
}

function renderImageTools(p, el) {
  const a = (el.adjust ||= { mode: 'grayscale', brightness: 0, contrast: 0, gamma: 1, invert: false, threshold: 128 });
  heading(p, 'Image adjustments', true);
  const upd = (k) => (v) => {
    checkpoint(`${el.id}-adj-${k}`);
    a[k] = v;
    refresh();
  };
  field(p, 'Engrave mode', a.mode, (v) => {
    upd('mode')(v);
    renderProps();
  }, { options: { grayscale: 'Grayscale (power varies)', threshold: 'Threshold (black & white)', dither: 'Dither (Floyd–Steinberg)' } });
  field(p, `Brightness (${a.brightness})`, a.brightness, upd('brightness'), { type: 'range', min: -100, max: 100, step: 1 });
  field(p, `Contrast (${a.contrast})`, a.contrast, upd('contrast'), { type: 'range', min: -100, max: 100, step: 1 });
  field(p, `Gamma (${a.gamma})`, a.gamma, upd('gamma'), { type: 'range', min: 0.2, max: 3, step: 0.05 });
  if (a.mode === 'threshold') field(p, `Threshold (${a.threshold})`, a.threshold, upd('threshold'), { type: 'range', min: 1, max: 254, step: 1 });
  field(p, 'Invert', a.invert, upd('invert'), { type: 'checkbox' });

  heading(p, 'Make editable', true);
  buttons(p, [['✨ Make editable with Claude', () => makeEditableWithClaude(el), 'primary']]);
  tip(p, 'Claude reads the picture and rebuilds it as <b>real text</b> (editable in Quick Fill), <b>shapes</b>, and <b>image pieces</b> for logos/artwork. The original stays hidden in Layers.');
  tip(p, 'Or by hand: put <b>Erase boxes</b> over old names / numbers, add new <b>Text</b> on top, then trace below.');
  buttons(p, [['＋ Erase box here', () => addErase(el)]]);

  heading(p, 'Trace to vector', true);
  const t = state.trace;
  const canvasHost = document.createElement('div');
  const updatePreview = () => {
    try {
      const { canvas } = thresholdCanvas(el, els(), { ...t, pxPerMm: Math.min(t.pxPerMm, 8) });
      canvas.className = 'trace-preview';
      canvasHost.replaceChildren(canvas);
    } catch {
      canvasHost.textContent = 'Preview unavailable';
    }
  };
  field(p, 'Threshold', t.threshold, (v) => {
    t.threshold = +v;
    updatePreview();
  }, { type: 'range', min: 1, max: 254 });
  const r = row(p);
  field(r, 'Invert', t.invert, (v) => {
    t.invert = v;
    updatePreview();
  }, { type: 'checkbox' });
  field(r, 'Detail', t.pxPerMm, (v) => (t.pxPerMm = +v), { options: { 6: 'Low', 12: 'Normal', 20: 'High', 30: 'Max' } });
  p.appendChild(canvasHost);
  buttons(p, [['Convert to vector (trace)', () => convertImage(el)]]);
  loadImage(el.src).then(updatePreview, () => {});
}

function renderWorkspaceProps(p) {
  const c = card();
  heading(p, 'Workspace');
  field(p, 'Size / project type', c.preset, (v) => {
    checkpoint();
    applyPreset(c, v);
    renderAll();
    fitZoom();
  }, { options: Object.fromEntries(Object.entries(CARD_PRESETS).map(([k, v]) => [k, v.label])) });
  const r = row(p);
  const onSize = (k) => (v) => {
    checkpoint(`card-${k}`);
    c[k] = v;
    c.preset = 'custom';
    renderStage();
  };
  field(r, 'Width (mm)', c.w, onSize('w'), { type: 'number', step: 0.1, min: 5 });
  field(r, 'Height (mm)', c.h, onSize('h'), { type: 'number', step: 0.1, min: 5 });
  const r2 = row(p);
  field(r2, 'Shape', c.shape || 'rect', (v) => {
    checkpoint();
    c.shape = v;
    renderStage();
  }, { options: { rect: 'Rectangle', ellipse: 'Round / oval' } });
  field(r2, 'Corner radius', c.radius, (v) => {
    checkpoint('card-r');
    c.radius = v;
    renderStage();
  }, { type: 'number', step: 0.1, min: 0 });
  field(p, 'Material preview', c.material, (v) => {
    checkpoint();
    c.material = v;
    renderStage();
  }, { options: Object.fromEntries(Object.entries(MATERIALS).map(([k, v]) => [k, v.label])) });
  field(p, 'Cut the outline (red layer)', c.includeOutline, (v) => {
    checkpoint();
    c.includeOutline = v;
    renderStage();
  }, { type: 'checkbox' });
  tip(
    p,
    `<b>Quick start</b><br>
    • <b>New…</b> has templates, <b>✨ AI Imagine</b> and <b>Make a picture editable</b>.<br>
    • <b>Quick Fill</b> (left) edits every name, number and QR link.<br>
    • Draw with <b>Pen / ▭ / ◯</b>, or use <b>Add</b>. Paste images with Ctrl/Cmd+V.<br>
    • Shift-click or drag a box to select several items, then align, group or array them.<br>
    • Colours: <b>black</b> = engrave fill, <b>blue</b> = line engrave, <b>red</b> = cut.<br>
    • <b>Laser settings</b> sets speed/power/passes for G-code export.`
  );
}

// Re-renders everything except panels that currently have keyboard focus
// (so typing is not interrupted).
function refresh() {
  renderStage();
  renderLayers();
  const active = document.activeElement;
  if (!$('#quickFill').contains(active)) renderQuickFill();
  if (!$('#props').contains(active) || active?.type === 'range') renderPropsKeepRange();
}

// Range sliders keep focus while dragging; rebuild the panel but restore it.
function renderPropsKeepRange() {
  const active = document.activeElement;
  if (active?.type === 'range' && $('#props').contains(active)) {
    // labels show the value; update the label text only
    const l = active.closest('label');
    if (l?.firstChild?.nodeType === 3) l.firstChild.textContent = l.firstChild.textContent.replace(/\(.*\)/, `(${active.value})`);
    return;
  }
  renderProps();
}

function renderAll() {
  loadCustomFonts();
  state.project.laser ||= laserDefaults();
  const ids = new Set(els().map((e) => e.id));
  state.sel = new Set([...state.sel].filter((id) => ids.has(id)));
  syncSideToggle();
  renderStage();
  renderLayers();
  renderQuickFill();
  renderProps();
}

function syncSideToggle() {
  for (const b of document.querySelectorAll('#sideToggle button')) b.classList.toggle('active', b.dataset.side === state.side);
  for (const b of document.querySelectorAll('#toolBar button')) b.classList.toggle('active', b.dataset.tool === state.tool);
}

// ---------- actions ----------

function select(ids, { add = false, toggle = false } = {}) {
  const list = ids == null ? [] : Array.isArray(ids) ? ids : [ids];
  const expanded = withGroup(list);
  if (toggle) {
    const allIn = [...expanded].every((id) => state.sel.has(id));
    for (const id of expanded) allIn ? state.sel.delete(id) : state.sel.add(id);
  } else if (add) {
    for (const id of expanded) state.sel.add(id);
  } else {
    state.sel = expanded;
  }
  renderStage();
  renderLayers();
  renderProps();
}

function addElement(el, { keepTool = false } = {}) {
  checkpoint();
  els().push(el);
  state.sel = new Set([el.id]);
  if (!keepTool) state.tool = 'select';
  renderAll();
}

function centerOnCard(el, w, h) {
  el.x = round((card().w - w) / 2, 2);
  el.y = round((card().h - h) / 2, 2);
}

async function onAdd(kind) {
  const c = card();
  const scaleK = Math.max(1, Math.min(c.w, c.h) / 54); // bigger defaults on big workspaces
  const centered = (el) => {
    const g = elementGeometry(el, ctx);
    centerOnCard(el, g.w, g.h);
    return addElement(el);
  };
  switch (kind) {
    case 'text':
      return centered(makeText({ text: 'New text', sizePt: 10 * scaleK }));
    case 'rect':
      return centered(makeRect({ w: 20 * scaleK, h: 12 * scaleK }));
    case 'ellipse':
      return centered(makeEllipse({ w: 12 * scaleK, h: 12 * scaleK }));
    case 'polygon':
      return centered(makePolygon({ w: 14 * scaleK, h: 14 * scaleK }));
    case 'star':
      return centered(makeStar({ w: 14 * scaleK, h: 14 * scaleK }));
    case 'line':
      return centered(makeRect({ name: 'Line', op: 'engrave', w: 30 * scaleK, h: 0.3 }));
    case 'chip':
      return addElement(makeChip());
    case 'chipart':
      return addElement(makeChipArt());
    case 'contactless':
      return addElement(makeContactless());
    case 'qr': {
      const el = makeQr({ w: 18 * scaleK, h: 18 * scaleK });
      el.x = round(c.w - el.w - 6);
      el.y = round((c.h - el.w) / 2);
      return addElement(el);
    }
    case 'hole':
      return addElement(makeEllipse({ name: 'Key-ring hole', op: 'cut', w: 4, h: 4, x: c.w - 8, y: 4 }));
    case 'erase':
      return addErase(null);
    case 'image':
      return importImage();
    case 'svg':
      return importSvgLogo();
    case 'paste':
      return pasteFromSystemClipboard();
    default:
  }
}

function addErase(over) {
  const el = makeErase();
  if (over) {
    el.w = Math.min(25, over.w / 2);
    el.h = Math.min(6, over.h / 3);
    el.x = round(over.x + over.w / 4);
    el.y = round(over.y + over.h / 3);
  } else {
    centerOnCard(el, el.w, el.h);
  }
  addElement(el);
  toast('Drag the orange box over the text you want to hide.');
}

async function importImage() {
  const file = await platform.pickFile('image/png,image/jpeg,image/webp,image/bmp,image/gif');
  if (!file) return null;
  return placeImage(await platform.readAsDataURL(file), file.name.replace(/\.[^.]+$/, ''));
}

// Places an image on the workspace. A picture shaped like the workspace fills it.
async function placeImage(src, name = 'Image') {
  let img;
  try {
    img = await loadImage(src);
  } catch {
    toast('Could not read that image.');
    return null;
  }
  const c = card();
  const aspect = img.naturalWidth / img.naturalHeight;
  const el = makeImage({ name, src });
  if (Math.abs(aspect - c.w / c.h) / (c.w / c.h) < 0.12) {
    Object.assign(el, { x: 0, y: 0, w: c.w, h: c.h });
    toast('Image placed. Click “✨ Make editable with Claude” to turn its text into editable text, or use Erase boxes.', 4500);
  } else {
    el.w = Math.min(c.w * 0.5, c.h * 0.6 * aspect);
    el.h = el.w / aspect;
    centerOnCard(el, el.w, el.h);
  }
  el.w = round(el.w, 3);
  el.h = round(el.h, 3);
  checkpoint();
  els().unshift(el); // images go behind everything else
  state.sel = new Set([el.id]);
  state.tool = 'select';
  renderAll();
  return el;
}

async function pasteFromSystemClipboard() {
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = it.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      const blob = await it.getType(type);
      const src = await platform.readAsDataURL(blob);
      return placeImage(src, 'Pasted image');
    }
    toast('No image on the clipboard – copy an image first (or press Ctrl/Cmd+V).');
  } catch {
    toast('Press Ctrl/Cmd+V to paste the copied image.');
  }
}

async function importSvgLogo() {
  const file = await platform.pickFile('.svg,image/svg+xml');
  if (!file) return;
  try {
    const res = importSvg(await platform.readAsText(file));
    const c = card();
    const aspect = res.bounds.w / (res.bounds.h || 1);
    const w = Math.min(c.w * 0.35, c.h * 0.4 * aspect);
    const el = makeVector({ name: file.name.replace(/\.[^.]+$/, ''), paths: res.paths, bounds: res.bounds, fillRule: res.fillRule, w: round(w, 3), h: round(w / aspect, 3) });
    centerOnCard(el, el.w, el.h);
    addElement(el);
    if (res.skippedText) toast('Note: text inside the SVG was skipped – convert text to paths in your design app.', 4500);
  } catch (e) {
    toast(e.message || 'Could not import SVG');
  }
}

async function convertImage(el) {
  await loadImage(el.src);
  const res = traceImage(el, els(), state.trace);
  if (!res.cmds.length) return toast('Nothing dark enough was found – try moving the threshold slider.');
  checkpoint();
  const vec = makeVector({
    name: `${el.name || 'Image'} (vector)`,
    op: el.op === 'none' ? 'engrave' : el.op,
    x: el.x,
    y: el.y,
    w: el.w,
    h: el.h,
    rotation: el.rotation,
    flipX: el.flipX,
    flipY: el.flipY,
    paths: res.cmds,
    bounds: { x: 0, y: 0, w: el.w, h: el.h },
  });
  const list = els();
  // keep the original image as a hidden guide so the user can re-trace later
  el.hidden = true;
  el.op = 'none';
  list.splice(list.indexOf(el) + 1, 0, vec);
  state.sel = new Set([vec.id]);
  renderAll();
  toast(`Converted to vector (${res.loops} shapes). The original image is kept hidden in Layers.`, 4000);
}

async function loadFontFile() {
  const file = await platform.pickFile('.ttf,.otf,.woff,font/ttf,font/otf,font/woff');
  if (!file) return null;
  try {
    const buf = await platform.readAsArrayBuffer(file);
    const font = opentype.parse(buf);
    const key = `custom:${newId()}`;
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    state.project.customFonts.push({ key, label: font.names.fontFamily?.en || file.name, data: btoa(bin) });
    state.fonts[key] = font;
    return key;
  } catch {
    toast('That font could not be loaded (WOFF2 is not supported – use TTF, OTF or WOFF).', 4500);
    return null;
  }
}

// Moves elements so their world bounds shift by (dx, dy).
function shift(list, dx, dy) {
  for (const e of list) {
    e.x = round(e.x + dx, 3);
    e.y = round(e.y + dy, 3);
  }
}

function align(how) {
  const sel = selectedEls().filter((e) => !e.locked);
  if (!sel.length) return;
  checkpoint();
  const c = card();
  const ref = sel.length === 1 ? { x: 0, y: 0, w: c.w, h: c.h } : unionBox(sel);
  // move groups as one unit
  const units = unitsOf(sel);
  for (const u of units) {
    const b = unionBox(u);
    let dx = 0;
    let dy = 0;
    if (how === 'left') dx = ref.x - b.x;
    if (how === 'right') dx = ref.x + ref.w - (b.x + b.w);
    if (how === 'hcenter') dx = ref.x + ref.w / 2 - (b.x + b.w / 2);
    if (how === 'top') dy = ref.y - b.y;
    if (how === 'bottom') dy = ref.y + ref.h - (b.y + b.h);
    if (how === 'vcenter') dy = ref.y + ref.h / 2 - (b.y + b.h / 2);
    shift(u, dx, dy);
  }
  refresh();
}

// Splits a selection into movable units (each group is one unit).
function unitsOf(sel) {
  const map = new Map();
  for (const e of sel) {
    const k = e.group || e.id;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(e);
  }
  return [...map.values()];
}

function distribute(axis) {
  const units = unitsOf(selectedEls().filter((e) => !e.locked));
  if (units.length < 3) return;
  checkpoint();
  const withB = units.map((u) => ({ u, b: unionBox(u) }));
  const key = axis === 'x' ? 'x' : 'y';
  const size = axis === 'x' ? 'w' : 'h';
  withB.sort((a, b) => a.b[key] + a.b[size] / 2 - (b.b[key] + b.b[size] / 2));
  const first = withB[0].b[key] + withB[0].b[size] / 2;
  const last = withB[withB.length - 1].b[key] + withB[withB.length - 1].b[size] / 2;
  const step = (last - first) / (withB.length - 1);
  withB.forEach(({ u, b }, i) => {
    const d = first + i * step - (b[key] + b[size] / 2);
    shift(u, axis === 'x' ? d : 0, axis === 'y' ? d : 0);
  });
  refresh();
}

function flip(axis) {
  const sel = selectedEls().filter((e) => !e.locked);
  if (!sel.length) return;
  checkpoint();
  const u = unionBox(sel);
  for (const e of sel) {
    const b = worldBox(e);
    if (axis === 'x') {
      e.flipX = !e.flipX;
      e.rotation = -(e.rotation || 0);
      if (sel.length > 1) shift([e], u.x + u.x + u.w - (b.x + b.x + b.w), 0);
    } else {
      e.flipY = !e.flipY;
      e.rotation = -(e.rotation || 0);
      if (sel.length > 1) shift([e], 0, u.y + u.y + u.h - (b.y + b.y + b.h));
    }
  }
  refresh();
}

function scaleSelection(k) {
  const sel = selectedEls().filter((e) => !e.locked);
  const u = unionBox(sel);
  for (const e of sel) {
    const b = worldBox(e);
    if (e.type === 'text') e.sizePt = round(e.sizePt * k, 2);
    else {
      e.w = round(e.w * k, 3);
      e.h = round(e.h * k, 3);
    }
    if (e.type === 'text' && e.letterSpacing) e.letterSpacing = round(e.letterSpacing * k, 3);
    const nb = worldBox(e);
    // keep each item's position relative to the selection's top-left corner
    shift([e], u.x + (b.x - u.x) * k - nb.x, u.y + (b.y - u.y) * k - nb.y);
  }
}

function reorder(dir) {
  const sel = selectedEls();
  if (!sel.length) return;
  checkpoint();
  const list = els();
  const order = dir > 0 ? [...sel].reverse() : sel;
  for (const el of order) {
    const i = list.indexOf(el);
    const j = i + dir;
    if (j < 0 || j >= list.length || state.sel.has(list[j].id)) continue;
    [list[i], list[j]] = [list[j], list[i]];
  }
  renderStage();
  renderLayers();
}

const cloneEls = (list) => JSON.parse(JSON.stringify(list));

// Gives copies new ids and new group ids (shared among copies of one group).
function freshCopies(list, dx = 0, dy = 0) {
  const groupMap = new Map();
  return cloneEls(list).map((e) => {
    e.id = newId();
    if (e.group) {
      if (!groupMap.has(e.group)) groupMap.set(e.group, newId());
      e.group = groupMap.get(e.group);
    }
    e.x = round(e.x + dx, 3);
    e.y = round(e.y + dy, 3);
    return e;
  });
}

function duplicate() {
  const sel = selectedEls();
  if (!sel.length) return;
  checkpoint();
  const copies = freshCopies(sel, 2, 2);
  els().push(...copies);
  state.sel = new Set(copies.map((e) => e.id));
  renderAll();
}

function copySelection(cut = false) {
  const sel = selectedEls();
  if (!sel.length) return false;
  state.clipboard = cloneEls(sel);
  if (cut) {
    checkpoint();
    state.project.sides[state.side] = els().filter((e) => !state.sel.has(e.id));
    state.sel.clear();
    renderAll();
  }
  toast(`${cut ? 'Cut' : 'Copied'} ${sel.length} item${sel.length > 1 ? 's' : ''}`);
  return true;
}

function pasteInternal() {
  if (!state.clipboard?.length) return false;
  checkpoint();
  const copies = freshCopies(state.clipboard, 2, 2);
  state.clipboard = cloneEls(copies); // the next paste steps further
  els().push(...copies);
  state.sel = new Set(copies.map((e) => e.id));
  renderAll();
  return true;
}

function removeSelected() {
  if (!state.sel.size) return;
  checkpoint();
  state.project.sides[state.side] = els().filter((e) => !state.sel.has(e.id));
  state.sel.clear();
  renderAll();
}

function moveToOtherSide() {
  const sel = selectedEls();
  if (!sel.length) return;
  checkpoint();
  state.project.sides[state.side] = els().filter((e) => !state.sel.has(e.id));
  state.side = state.side === 'front' ? 'back' : 'front';
  els().push(...sel);
  renderAll();
}

function groupSelected() {
  const sel = selectedEls();
  if (sel.length < 2) return;
  checkpoint();
  const g = newId();
  for (const e of sel) e.group = g;
  refresh();
  toast('Grouped – click any member to select the whole group');
}

function ungroupSelected() {
  const sel = selectedEls();
  if (!sel.some((e) => e.group)) return;
  checkpoint();
  for (const e of sel) delete e.group;
  refresh();
}

function toggleLock() {
  const sel = selectedEls();
  if (!sel.length) return;
  checkpoint();
  const lock = !sel.every((e) => e.locked);
  for (const e of sel) e.locked = lock || undefined;
  refresh();
}

function makeArray() {
  const sel = selectedEls();
  if (!sel.length) return;
  const a = state.arrayOpts;
  checkpoint();
  const u = unionBox(sel);
  const created = [];
  if (a.mode === 'grid') {
    const cols = Math.max(1, Math.round(a.cols));
    const rows = Math.max(1, Math.round(a.rows));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!r && !c) continue;
        created.push(...freshCopies(sel, c * (u.w + a.gapX), r * (u.h + a.gapY)));
      }
    }
  } else {
    const n = Math.max(2, Math.round(a.count));
    const cx = u.x + u.w / 2;
    const cy = u.y + u.h / 2 + a.radius; // the original sits at the top of the circle
    for (let i = 1; i < n; i++) {
      const ang = (i * 2 * Math.PI) / n;
      const px = cx + a.radius * Math.sin(ang);
      const py = cy - a.radius * Math.cos(ang);
      const copies = freshCopies(sel, px - (u.x + u.w / 2), py - (u.y + u.h / 2));
      if (a.rotate) {
        for (const e of copies) {
          // rotate each copy about the array centre
          const b = worldBox(e);
          const ecx = b.x + b.w / 2;
          const ecy = b.y + b.h / 2;
          const rx = cx + (ecx - cx) * Math.cos(0) - (ecy - cy) * Math.sin(0);
          e.rotation = round((e.rotation || 0) + (ang * 180) / Math.PI, 3);
          const nb = worldBox(e);
          shift([e], rx - (nb.x + nb.w / 2), ecy - (nb.y + nb.h / 2));
        }
      }
      created.push(...copies);
    }
  }
  els().push(...created);
  state.sel = new Set([...sel.map((e) => e.id), ...created.map((e) => e.id)]);
  renderAll();
  toast(`Created ${created.length} copies – press Ctrl/Cmd+G to group them`);
}

// ---------- project files ----------

async function saveProject() {
  const name = await platform.saveFile('design.lcx', JSON.stringify(state.project, null, 1), {
    name: 'LaserCutX project',
    extensions: ['lcx'],
    mime: 'application/json',
  });
  if (name) {
    state.dirty = false;
    toast('Project saved');
  }
}

async function openProject() {
  const file = await platform.pickFile('.lcx,.json,application/json');
  if (!file) return;
  try {
    const p = JSON.parse(await platform.readAsText(file));
    if (p.format !== 'lasercutx' || !p.sides) throw new Error('bad');
    checkpoint();
    state.project = p;
    state.project.customFonts ||= [];
    state.sel.clear();
    state.side = 'front';
    await preloadImages(p);
    renderAll();
    fitZoom();
    toast(`Opened ${file.name}`);
  } catch {
    toast('That file is not a LaserCutX project.');
  }
}

function startProject(project) {
  checkpoint();
  state.project = project;
  state.side = 'front';
  state.sel.clear();
  state.tool = 'select';
  renderAll();
  fitZoom();
}

// Small picture of a template for the start screen.
function templateThumb(key) {
  const p = newProject(key);
  const c = p.card;
  const mat = MATERIALS[c.material] || MATERIALS.silver;
  const paths = p.sides.front
    .filter((el) => !el.hidden && OPS[el.op])
    .map((el) => {
      const g = elementGeometry(el, ctx);
      if (!g.cmds.length) return '';
      const d = toSvgD(g.cmds, 2);
      return el.op === 'engrave'
        ? `<path d="${d}" fill="${mat.mark}" fill-rule="${g.fillRule}"/>`
        : `<path d="${d}" fill="none" stroke="${el.op === 'cut' ? '#ff3b30' : mat.mark}" stroke-width="${Math.max(c.w, c.h) / 220}"/>`;
    })
    .join('');
  const m = Math.max(c.w, c.h) * 0.04;
  return `<svg viewBox="${-m} ${-m} ${c.w + 2 * m} ${c.h + 2 * m}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <defs><linearGradient id="tg-${key}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${mat.base2}"/><stop offset="0.6" stop-color="${mat.base}"/><stop offset="1" stop-color="${mat.base2}"/></linearGradient></defs>
    <path d="${toSvgD(outlinePath(c), 2)}" fill="url(#tg-${key})"/>${paths}</svg>`;
}

// The start screen (also opened by New…).
function showNewDialog({ welcome = false } = {}) {
  const dlg = $('#dlgNew');
  const list = $('#templateList');
  $('#newTitle').textContent = welcome ? 'Welcome – what do you want to make?' : 'Start something new';
  $('#newCancel').textContent = welcome ? 'Skip – start with a blank card' : 'Cancel';
  list.innerHTML = '';

  const quick = document.createElement('div');
  quick.className = 'quickstart';
  const open = document.createElement('button');
  open.type = 'button';
  open.innerHTML = '<b>📂 Open a project…</b><span>Continue a saved .lcx design</span>';
  open.onclick = () => {
    dlg.close();
    openProject();
  };
  const manual = document.createElement('button');
  manual.type = 'button';
  manual.innerHTML = '<b>🖼 Start from an image…</b><span>Cover old names / numbers with Erase boxes and type your own</span>';
  manual.onclick = async () => {
    dlg.close();
    startProject(newProject('blank'));
    await importImage();
  };
  const blank = document.createElement('button');
  blank.type = 'button';
  blank.innerHTML = '<b>⬜ Blank card</b><span>Empty credit-card size – start from scratch</span>';
  blank.onclick = () => {
    dlg.close();
    startProject(newProject('blank'));
  };
  quick.append(blank, open, manual);
  list.appendChild(quick);

  let group = '';
  let grid = null;
  for (const [key, t] of Object.entries(TEMPLATES)) {
    if (key === 'blank') continue; // offered in the quick-start row
    const g = t.group || 'Templates';
    if (g !== group) {
      group = g;
      const h = document.createElement('div');
      h.className = 'tgroup';
      h.textContent = group;
      grid = document.createElement('div');
      grid.className = 'tgrid';
      list.append(h, grid);
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tcard';
    b.title = t.desc || '';
    b.innerHTML = `<div class="thumb">${templateThumb(key)}</div><b>${t.label}</b><span>${t.desc || ''}</span>`;
    b.onclick = () => {
      dlg.close();
      startProject(newProject(key));
    };
    grid.appendChild(b);
  }
  $('#aiNote').textContent = state.aiSignedIn ? 'Claude is connected.' : 'You will be asked for your Claude API key the first time.';
  if (!dlg.open) dlg.showModal();
}

// ---------- Claude: AI Imagine & Make editable ----------

function aiOptions() {
  return {
    fonts: FONTS.map((f) => f.key),
    formats: Object.keys(FORMATS),
    presets: Object.keys(CARD_PRESETS),
    materials: Object.keys(MATERIALS),
  };
}

// Opens the Claude key popup when no key is saved; `retry` runs after saving.
async function requireAi(retry) {
  if (await claude.isSignedIn()) return true;
  state.pendingAi = retry || null;
  showSettings('claude', 'Add your Claude API key to use AI features – it only takes a minute.');
  return false;
}

async function imagine() {
  const prompt = $('#aiPrompt').value.trim();
  if (!prompt) return toast('Describe what you want to make first.');
  $('#dlgNew').close();
  if (!(await requireAi(imagine))) return;
  busy('✨ Claude is designing your layout…');
  try {
    const c = card();
    const layout = await claude.imagine({ prompt, workspace: { w: c.w, h: c.h, label: CARD_PRESETS[c.preset]?.label || 'Custom' }, ...aiOptions() });
    const p = newProject('blank');
    applyPreset(p.card, layout.preset);
    p.card.material = MATERIALS[layout.material] ? layout.material : p.card.material;
    for (const side of ['front', 'back']) {
      p.sides[side] = await layoutToElements(layout.elements.filter((e) => e.side === side), { x: 0, y: 0, w: p.card.w, h: p.card.h });
    }
    startProject(p);
    toast(`✨ “${layout.title}” – everything is editable. Try Quick Fill on the left.`, 5000);
  } catch (e) {
    if (e.needsKey) requireAi(imagine);
    else toast(e.message || 'AI Imagine failed', 6000);
  } finally {
    busy(null);
  }
}

async function makePictureEditableNew() {
  $('#dlgNew').close();
  if (!(await requireAi(makePictureEditableNew))) return;
  const file = await platform.pickFile('image/png,image/jpeg,image/webp,image/bmp,image/gif');
  if (!file) return;
  $('#dlgNew').close();
  const src = await platform.readAsDataURL(file);
  startProject(newProject('blank'));
  const el = await placeImage(src, file.name.replace(/\.[^.]+$/, ''));
  if (el) await makeEditableWithClaude(el, { adoptWorkspace: true });
}

// Rebuilds a picture as editable items placed over the image's box.
async function makeEditableWithClaude(imgEl, { adoptWorkspace = false } = {}) {
  const again = () => makeEditableWithClaude(imgEl, { adoptWorkspace });
  if (!(await requireAi(again))) return;
  busy('✨ Claude is reading the picture…');
  try {
    const pic = await imageForAi(imgEl.src);
    const layout = await claude.fromImage({ image: pic.data, mediaType: pic.mediaType, ...aiOptions() });
    const c = card();
    checkpoint();
    if (adoptWorkspace) {
      // fit the workspace to what Claude recognised, keeping the picture's shape
      applyPreset(c, layout.preset);
      if (MATERIALS[layout.material]) c.material = layout.material;
      if (Math.abs(c.w / c.h - pic.aspect) / pic.aspect > 0.12) {
        c.preset = 'custom';
        c.h = round(c.w / pic.aspect, 2);
      }
      Object.assign(imgEl, { x: 0, y: 0, w: c.w, h: c.h, rotation: 0 });
    }
    const box = { x: imgEl.x, y: imgEl.y, w: imgEl.w, h: imgEl.h };
    const made = await layoutToElements(layout.elements, box, imgEl.src);
    // keep the original as a hidden, non-engraving guide underneath
    imgEl.hidden = true;
    imgEl.op = 'none';
    imgEl.name = `${imgEl.name || 'Picture'} (original)`;
    const list = els();
    list.splice(list.indexOf(imgEl) + 1, 0, ...made);
    state.sel = new Set(made.map((e) => e.id));
    renderAll();
    if (adoptWorkspace) fitZoom();
    const texts = made.filter((e) => e.type === 'text').length;
    const pics = made.filter((e) => e.type === 'image').length;
    toast(`✨ Rebuilt as ${texts} text item${texts === 1 ? '' : 's'}, ${made.length - texts - pics} shape${made.length - texts - pics === 1 ? '' : 's'} and ${pics} image piece${pics === 1 ? '' : 's'}. Original hidden in Layers.`, 6000);
  } catch (e) {
    if (e.needsKey) requireAi(again);
    else toast(e.message || 'Could not make the picture editable', 6000);
  } finally {
    busy(null);
  }
}

// Converts Claude's layout (fractions of `box`) into editor elements.
export async function layoutToElements(items, box, sourceSrc = null) {
  const out = [];
  const clamp = (v) => Math.max(0, Math.min(1, Number(v) || 0));
  for (const it of items) {
    const fx = clamp(it.x);
    const fy = clamp(it.y);
    const fw = Math.max(0.002, Math.min(1 - fx, Number(it.w) || 0.05));
    const fh = Math.max(0.002, Math.min(1 - fy, Number(it.h) || 0.05));
    const x = round(box.x + fx * box.w, 3);
    const y = round(box.y + fy * box.h, 3);
    const w = round(fw * box.w, 3);
    const h = round(fh * box.h, 3);
    const op = OPS[it.op] ? it.op : 'engrave';
    const base = { name: it.name || it.kind, op, rotation: Number(it.rotation) || 0 };
    switch (it.kind) {
      case 'text': {
        if (!it.text) break;
        const lines = String(it.text).split('\n').length;
        const el = makeText({
          ...base,
          text: it.text,
          font: FONTS.some((f) => f.key === it.font) ? it.font : 'roboto',
          weight: it.bold ? 700 : 400,
          align: it.align || 'left',
          letterSpacing: Math.max(-1, Math.min(5, Number(it.letterSpacing) || 0)),
          format: FORMATS[it.format] ? it.format : 'none',
          sizePt: round(h / (lines * 1.2) / PT_TO_MM, 2),
        });
        // shrink to the measured width if the font runs wider than the original
        let g = elementGeometry(el, ctx);
        if (g.w > w * 1.06) {
          el.sizePt = round((el.sizePt * w) / g.w, 2);
          g = elementGeometry(el, ctx);
        }
        el.y = round(y + (h - g.h) / 2, 3);
        if (el.align === 'center') {
          el.anchor = 'center';
          el.x = round(x + w / 2, 3);
        } else if (el.align === 'right') el.x = round(x + w - g.w, 3);
        else el.x = x;
        out.push(el);
        break;
      }
      case 'rect':
        out.push(makeRect({ ...base, x, y, w, h, radius: Math.max(0, Number(it.cornerRadius) || 0) }));
        break;
      case 'line':
        out.push(makeRect({ ...base, op: op === 'cut' ? 'cut' : 'engrave', x, y, w, h: Math.max(0.2, Math.min(h, 1)) }));
        break;
      case 'ellipse':
        out.push(makeEllipse({ ...base, x, y, w, h }));
        break;
      case 'polygon':
        out.push(makePolygon({ ...base, x, y, w, h, sides: Math.max(3, Math.round(it.polygonSides || 6)) }));
        break;
      case 'star':
        out.push(makeStar({ ...base, x, y, w, h, sides: Math.max(3, Math.round(it.polygonSides || 5)) }));
        break;
      case 'qr': {
        const s = Math.min(w, h);
        out.push(makeQr({ ...base, x, y, w: s, h: s, data: it.qrData || 'https://example.com' }));
        break;
      }
      case 'chip':
        out.push(makeChip({ ...base, x, y, w, h }));
        break;
      case 'contactless':
        out.push(makeContactless({ ...base, x, y, w, h }));
        break;
      case 'graphic':
        if (sourceSrc) {
          const src = await cropImage(sourceSrc, fx, fy, fw, fh);
          out.push(makeImage({ ...base, name: it.name || 'Artwork', op: 'engrave', x, y, w, h, src }));
        } else {
          // AI Imagine has no picture to cut from: leave a placeholder frame
          out.push(makeRect({ ...base, name: `${it.name || 'Artwork'} (placeholder – add an image)`, op: 'none', x, y, w, h, radius: 1 }));
        }
        break;
      default:
        break;
    }
  }
  await preloadImages({ sides: { front: out, back: [] } });
  return out;
}

async function refreshAiStatus() {
  state.aiSignedIn = await claude.isSignedIn();
}

// ---------- settings (laser layers + Claude AI) ----------

function showSettings(tab = 'laser', message = '') {
  const L = (state.project.laser ||= laserDefaults());
  const rows = [
    ['engrave', 'Engrave (fill)', '#000'],
    ['score', 'Line engrave', '#00f'],
    ['cut', 'Cut', '#f00'],
    ['image', 'Images (raster)', '#888'],
  ];
  $('#laserRows').innerHTML = rows
    .map(
      ([k, label, color]) => `<tr data-k="${k}">
      <td><span class="sw" style="background:${color}"></span> ${label}</td>
      <td><input type="checkbox" data-f="output" ${L[k].output ? 'checked' : ''}></td>
      <td><input type="number" data-f="speed" min="1" step="50" value="${L[k].speed}"></td>
      <td><input type="number" data-f="power" min="0" max="100" step="1" value="${L[k].power}"></td>
      <td><input type="number" data-f="passes" min="1" step="1" value="${L[k].passes}"></td>
      <td>${L[k].interval !== undefined ? `<input type="number" data-f="interval" min="0.02" step="0.01" value="${L[k].interval}">` : '–'}</td>
    </tr>`
    )
    .join('');
  const f = $('#settingsForm');
  f.maxS.value = L.machine.maxS;
  f.travel.value = L.machine.travel;
  f.laserMode.value = L.machine.laserMode;
  f.airAssist.checked = !!L.machine.airAssist;
  updateClaudePane(message);
  setSettingsTab(tab);
  if (!$('#dlgSettings').open) $('#dlgSettings').showModal();
}

function setSettingsTab(tab) {
  for (const b of document.querySelectorAll('#dlgSettings [data-tab]')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const p of document.querySelectorAll('#dlgSettings [data-pane]')) p.hidden = p.dataset.pane !== tab;
  if (tab === 'claude' && !state.aiSignedIn) setTimeout(() => $('#settingsForm').key.focus(), 50);
}

function updateClaudePane(message = '') {
  const on = state.aiSignedIn;
  $('#claudeStatus').textContent = message || (on ? '✓ Claude is connected. AI Imagine and Make editable are ready.' : 'Add your Claude API key to use ✨ AI Imagine and ✨ Make editable.');
  $('#claudeSignedOut').hidden = on;
  $('#claudeSignedIn').hidden = !on;
}

async function saveKey() {
  const input = $('#settingsForm').key;
  $('#claudeStatus').textContent = 'Checking your key…';
  try {
    await claude.saveKey(input.value);
  } catch (e) {
    $('#claudeStatus').textContent = e.message;
    return;
  }
  input.value = '';
  await refreshAiStatus();
  updateClaudePane();
  toast('✨ Claude connected');
  const next = state.pendingAi;
  state.pendingAi = null;
  if (next) {
    $('#dlgSettings').close();
    next();
  }
}

async function forgetKey() {
  await claude.forgetKey();
  await refreshAiStatus();
  updateClaudePane();
  toast('Claude key removed');
}

function saveLaserSettings() {
  checkpoint();
  const L = state.project.laser;
  for (const tr of document.querySelectorAll('#laserRows tr')) {
    const set = L[tr.dataset.k];
    for (const inp of tr.querySelectorAll('input')) {
      const k = inp.dataset.f;
      set[k] = inp.type === 'checkbox' ? inp.checked : Math.max(k === 'passes' ? 1 : 0, parseFloat(inp.value) || set[k]);
    }
  }
  const f = $('#settingsForm');
  L.machine.maxS = Math.max(1, parseFloat(f.maxS.value) || 1000);
  L.machine.travel = Math.max(100, parseFloat(f.travel.value) || 6000);
  L.machine.laserMode = f.laserMode.value;
  L.machine.airAssist = f.airAssist.checked;
  toast('Settings saved with the project');
}

// ---------- USB laser (GRBL) ----------

const machine = new Grbl({
  onStatus: (st) => {
    $('#mPos').textContent = `X ${st.x.toFixed(2)} · Y ${st.y.toFixed(2)}`;
    const pill = $('#mState');
    if (machine.connected && !machine.job) {
      pill.textContent = st.state;
      pill.className = `pill ${/alarm/i.test(st.state) ? 'alarm' : /run|jog|home/i.test(st.state) ? 'run' : 'ok'}`;
    }
  },
  onLog: (line) => mlog(line),
  onState: (s) => {
    const pill = $('#mState');
    pill.textContent = s;
    pill.className = `pill ${s === 'Disconnected' ? '' : s === 'Connected' ? 'ok' : 'run'}`;
    $('#mConnect').textContent = machine.connected ? 'Disconnect' : 'Connect via USB';
    $('.machine .mbody').classList.toggle('off', !machine.connected);
    $('#mPause').textContent = s === 'Paused' ? '▶ Resume' : '⏸ Pause';
  },
});

function mlog(line) {
  const box = $('#mLog');
  box.textContent = `${box.textContent}${line}\n`.split('\n').slice(-60).join('\n');
  box.scrollTop = box.scrollHeight;
}

function toggleMachinePanel() {
  const panel = $('#machinePanel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden && !serialSupported()) mlog('This browser cannot access USB. Use the LaserCutX desktop app, Chrome or Edge.');
  $('.machine .mbody').classList.toggle('off', !machine.connected);
}

async function machineAction(fn, label) {
  try {
    await fn();
  } catch (e) {
    mlog(`! ${label}: ${e.message}`);
    toast(`${label} failed: ${e.message}`);
  }
}

// G-code for the current side, with the chosen job origin.
function jobGcode() {
  const sideEls = els();
  const r = toGcode(state.project, state.side, ctx, { imageMask: (el, pxPerMm) => engraveMask(el, sideEls, pxPerMm) });
  return r;
}

async function startJob() {
  if (!machine.connected) return toast('Connect the laser first.');
  if (machine.job) return;
  await preloadImages(state.project);
  const { gcode, stats } = jobGcode();
  const origin = $('#mOrigin').value;
  const mins = Math.max(1, Math.round(stats.seconds / 60));
  const ok = confirm(
    `Start the ${state.side} side on the laser?\n\nEstimated time: about ${mins} min.\n\n⚠ Wear laser safety glasses, never leave the laser unattended, and keep a fire extinguisher nearby.`
  );
  if (!ok) return;
  let program = gcode;
  if (origin === 'current') program = `G10 L20 P1 X0 Y0\n${gcode}`; // start where the laser head is now
  if (origin === 'absolute') program = `G10 L2 P1 X0 Y0\n${gcode}`; // work coordinates = machine coordinates
  $('#mProgress').value = 0;
  mlog(`▶ Job started (${stats.lines} lines)`);
  try {
    const done = await machine.run(program, (d, t) => ($('#mProgress').value = d / t));
    mlog(done ? '✓ Job finished' : '■ Job stopped');
    toast(done ? 'Laser job finished' : 'Laser job stopped');
  } catch (e) {
    mlog(`! Job failed: ${e.message}`);
    toast(`Laser job failed: ${e.message}`, 5000);
  }
}

// ---------- export ----------

function bulkSheet(form) {
  if (!form.bulk.checked) return null;
  const count = Math.max(2, Math.min(100, parseInt(form.copies.value, 10) || 6));
  const cols = Math.max(1, Math.min(count, parseInt(form.cols.value, 10) || 3));
  const gap = Math.max(0, parseFloat(form.gap.value) || 0);
  return { count, cols, gap };
}

function showExportDialog(opts = {}) {
  const dlg = $('#dlgExport');
  const form = $('#exportForm');
  form.bulk.checked = !!opts.bulk;
  const update = () => {
    const sheet = bulkSheet(form);
    form.querySelector('.bulk').classList.toggle('off', !sheet);
    if (sheet) {
      const l = sheetLayout(card(), sheet);
      $('#bulkNote').textContent = `${sheet.count} copies in ${l.cols} × ${l.rows} – sheet ${round(l.w, 1)} × ${round(l.h, 1)} mm. Make sure it fits your laser bed.`;
    } else {
      $('#bulkNote').textContent = '';
    }
    const fmt = form.format.value;
    form.querySelector('.png-only').style.display = fmt === 'png' ? '' : 'none';
    const notes = {
      svg: 'Millimetre units – imports at true size. Layers are coloured so LightBurn assigns them automatically.',
      dxf: 'Vector only (images are left out – convert them to vector first). Layers: ENGRAVE, SCORE, CUT.',
      png: 'Black = engrave. DPI is stored in the file so it imports at the correct size.',
      gcode: 'For GRBL lasers. Uses speed/power/passes from Laser settings; images are raster-engraved; holes are cut before outlines.',
    };
    $('#exportNote').textContent = notes[fmt];
  };
  form.format.onchange = update;
  for (const n of ['bulk', 'copies', 'cols', 'gap']) form[n].oninput = update;
  update();
  dlg.showModal();
}

async function doExport() {
  const form = $('#exportForm');
  const fmt = form.format.value;
  const layers = ['engrave', 'score', 'cut'].filter((k) => form[k].checked);
  if (!layers.length) return toast('Choose at least one layer to export.');
  const sideChoice = form.side.value;
  const sides = sideChoice === 'both' ? ['front', 'back'] : [sideChoice === 'current' ? state.side : sideChoice];
  const mirror = form.mirror.checked;
  const sheet = bulkSheet(form);
  const layout = sheetLayout(card(), sheet);
  await preloadImages(state.project);

  const files = [];
  const skipped = [];
  let stats = null;
  for (const side of sides) {
    const sideEls = state.project.sides[side];
    const imageSrc = (el) => bakedImageSrc(el, sideEls);
    const base = `design-${side}${mirror ? '-mirrored' : ''}${sheet ? `-x${sheet.count}` : ''}`;
    if (fmt === 'svg') {
      files.push({ name: `${base}.svg`, data: toSVG(state.project, side, ctx, { layers, mirror, imageSrc, sheet }) });
    } else if (fmt === 'dxf') {
      const r = toDXF(state.project, side, ctx, { layers, mirror, sheet });
      skipped.push(...r.skipped);
      files.push({ name: `${base}.dxf`, data: r.dxf });
    } else if (fmt === 'gcode') {
      // export only the chosen layers: temporarily switch off the others
      const proj = JSON.parse(JSON.stringify(state.project));
      for (const k of ['engrave', 'score', 'cut']) if (!layers.includes(k)) proj.laser[k].output = false;
      if (!layers.includes('engrave')) proj.laser.image.output = false;
      const r = toGcode(proj, side, ctx, { mirror, sheet, imageMask: (el, pxPerMm) => engraveMask(el, sideEls, pxPerMm) });
      stats = r.stats;
      files.push({ name: `${base}.gcode`, data: r.gcode });
    } else {
      const maxDpi = Math.floor((16000 / Math.max(layout.w, layout.h)) * 25.4);
      const dpi = Math.min(parseInt(form.dpi.value, 10), maxDpi);
      if (dpi < parseInt(form.dpi.value, 10)) toast(`Sheet is large – PNG resolution lowered to ${dpi} DPI.`);
      const svg = toRasterSVG(state.project, side, ctx, { layers, mirror, invert: form.invert.checked, imageSrc, sheet });
      files.push({ name: `${base}-${dpi}dpi.png`, data: await svgToPng(svg, layout.w, layout.h, dpi) });
    }
  }
  const filter = {
    svg: { name: 'SVG', extensions: ['svg'], mime: 'image/svg+xml' },
    dxf: { name: 'DXF', extensions: ['dxf'], mime: 'application/dxf' },
    png: { name: 'PNG image', extensions: ['png'], mime: 'image/png' },
    gcode: { name: 'G-code', extensions: ['gcode', 'nc', 'gc'], mime: 'text/plain' },
  }[fmt];
  const res = files.length === 1 ? await platform.saveFile(files[0].name, files[0].data, filter) : await platform.saveFiles(files, filter);
  if (!res) return;
  let msg = `Exported ${files.map((f) => f.name).join(', ')}`;
  if (stats) msg += ` – estimated time ${Math.floor(stats.seconds / 60)} min ${stats.seconds % 60} s`;
  if (skipped.length) msg += ` – images skipped in DXF: ${skipped.join(', ')}`;
  toast(msg, 5000);
}

// ---------- zoom & pan ----------

function fitZoom() {
  const wrap = $('#stageWrap');
  const c = card();
  const P = pad();
  const z = Math.min((wrap.clientWidth - 40) / (c.w + P * 2), (wrap.clientHeight - 60) / (c.h + P * 2));
  state.zoom = Math.max(0.5, Math.min(60, z));
  renderStage();
}

// Zooms keeping the point under the cursor (or the view centre) still.
function zoomBy(f, evt) {
  const wrap = $('#stageWrap');
  const before = evt ? svgPoint(evt) : null;
  state.zoom = Math.max(0.5, Math.min(80, state.zoom * f));
  renderStage();
  if (before) {
    const svg = $('#stage');
    const m = svg.getScreenCTM();
    const sx = m.a * before[0] + m.e;
    const sy = m.d * before[1] + m.f;
    wrap.scrollLeft += sx - evt.clientX;
    wrap.scrollTop += sy - evt.clientY;
  }
}

// ---------- pointer interaction ----------

function svgPoint(evt) {
  const svg = $('#stage');
  const m = svg.getScreenCTM();
  if (!m) return [0, 0];
  const inv = invert([m.a, m.b, m.c, m.d, m.e, m.f]);
  return applyPoint(inv, evt.clientX, evt.clientY);
}

let drag = null;
let spaceDown = false;

function onPointerDown(evt) {
  const target = evt.target;
  const [px, py] = svgPoint(evt);
  const stage = $('#stage');

  // pan: middle button or space + drag
  if (evt.button === 1 || spaceDown) {
    const wrap = $('#stageWrap');
    drag = { mode: 'pan', sx: evt.clientX, sy: evt.clientY, sl: wrap.scrollLeft, st: wrap.scrollTop };
    stage.setPointerCapture(evt.pointerId);
    evt.preventDefault();
    return;
  }
  if (evt.button !== 0) return;

  if (state.tool === 'pen') {
    const pt = [snapV(px), snapV(py)];
    const pen = (state.pen ||= { points: [] });
    const first = pen.points[0];
    if (first && pen.points.length > 2 && Math.hypot(pt[0] - first[0], pt[1] - first[1]) < ui(1.5)) return finishPen(true);
    if (evt.detail >= 2 && pen.points.length > 1) return finishPen(false);
    pen.points.push(pt);
    renderStage();
    return;
  }
  if (state.tool === 'rect' || state.tool === 'ellipse') {
    drag = { mode: 'draw', kind: state.tool, px: snapV(px), py: snapV(py), box: null };
    stage.setPointerCapture(evt.pointerId);
    return;
  }

  if (target.classList.contains('handle') || target.classList.contains('rothandle')) {
    const el = selected();
    if (!el) return;
    checkpoint();
    const geo = elementGeometry(el, ctx);
    if (target.classList.contains('handle')) {
      drag = { mode: 'resize', el, inv: invert(geo.matrix), w0: geo.w, h0: geo.h, size0: el.sizePt, arc0: el.arc };
    } else {
      const [cx, cy] = applyPoint(geo.matrix, geo.w / 2, geo.h / 2);
      drag = { mode: 'rotate', el, cx, cy, a0: Math.atan2(py - cy, px - cx), r0: el.rotation || 0 };
    }
  } else if (target.classList.contains('hit')) {
    const id = target.dataset.id;
    if (evt.shiftKey || evt.ctrlKey || evt.metaKey) {
      select(id, { toggle: true });
      return;
    }
    if (!state.sel.has(id)) select(id);
    const movable = selectedEls().filter((e) => !e.locked);
    if (!movable.length) return;
    checkpoint();
    const anchor = worldBox(els().find((e) => e.id === id));
    drag = { mode: 'move', items: movable.map((e) => ({ e, x0: e.x, y0: e.y })), px, py, ax: anchor.x, ay: anchor.y, moved: false };
  } else {
    // empty space: box-select
    drag = { mode: 'marquee', px, py, add: evt.shiftKey || evt.ctrlKey || evt.metaKey, box: null };
    if (!drag.add && state.sel.size) {
      state.sel.clear();
      renderLayers();
      renderProps();
    }
  }
  stage.setPointerCapture(evt.pointerId);
  evt.preventDefault();
}

function onPointerMove(evt) {
  const [px, py] = svgPoint(evt);
  state.cursor = [px, py];
  if (!drag) {
    if (state.pen) renderStage();
    else renderStatus();
    return;
  }
  if (drag.mode === 'pan') {
    const wrap = $('#stageWrap');
    wrap.scrollLeft = drag.sl - (evt.clientX - drag.sx);
    wrap.scrollTop = drag.st - (evt.clientY - drag.sy);
    return;
  }
  if (drag.mode === 'move') {
    let dx = px - drag.px;
    let dy = py - drag.py;
    if (evt.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0); // constrain
    if (!evt.altKey && state.snap) {
      // snap the dragged item's top-left corner to the grid
      dx = snapV(drag.ax + dx) - drag.ax;
      dy = snapV(drag.ay + dy) - drag.ay;
    }
    for (const it of drag.items) {
      it.e.x = round(it.x0 + dx, 3);
      it.e.y = round(it.y0 + dy, 3);
    }
    drag.moved = true;
  } else if (drag.mode === 'resize') {
    const el = drag.el;
    const [lx, ly] = applyPoint(drag.inv, px, py);
    const w = Math.max(0.3, lx);
    const h = Math.max(0.3, ly);
    if (el.type === 'text') {
      el.sizePt = Math.max(1, round(drag.size0 * (w / drag.w0), 1));
    } else if (el.type === 'qr') {
      el.w = el.h = round(Math.max(w, h), 2);
    } else if ((el.type === 'image' || el.type === 'vector') !== evt.shiftKey) {
      const k = Math.max(w / drag.w0, h / drag.h0);
      el.w = round(drag.w0 * k, 3);
      el.h = round(drag.h0 * k, 3);
    } else {
      el.w = round(state.snap ? Math.max(state.snap, snapV(w)) : w, 3);
      el.h = round(state.snap ? Math.max(state.snap, snapV(h)) : h, 3);
    }
  } else if (drag.mode === 'rotate') {
    let deg = drag.r0 + ((Math.atan2(py - drag.cy, px - drag.cx) - drag.a0) * 180) / Math.PI;
    deg = evt.shiftKey ? Math.round(deg / 15) * 15 : Math.round(deg * 10) / 10;
    drag.el.rotation = ((deg % 360) + 360) % 360;
    if (drag.el.rotation > 180) drag.el.rotation -= 360;
  } else if (drag.mode === 'marquee' || drag.mode === 'draw') {
    let x2 = drag.mode === 'draw' ? snapV(px) : px;
    let y2 = drag.mode === 'draw' ? snapV(py) : py;
    if (drag.mode === 'draw' && evt.shiftKey) {
      const s = Math.max(Math.abs(x2 - drag.px), Math.abs(y2 - drag.py));
      x2 = drag.px + Math.sign(x2 - drag.px || 1) * s;
      y2 = drag.py + Math.sign(y2 - drag.py || 1) * s;
    }
    drag.box = { x: Math.min(drag.px, x2), y: Math.min(drag.py, y2), w: Math.abs(x2 - drag.px), h: Math.abs(y2 - drag.py) };
  }
  renderStage();
}

function onPointerUp() {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.mode === 'move' && !d.moved) state.undo.pop(); // a click, not a change
  if (d.mode === 'marquee' && d.box && (d.box.w > ui(0.5) || d.box.h > ui(0.5))) {
    const b = d.box;
    const hit = els()
      .filter((e) => {
        const wb = worldBox(e);
        return wb.x < b.x + b.w && wb.x + wb.w > b.x && wb.y < b.y + b.h && wb.y + wb.h > b.y;
      })
      .map((e) => e.id);
    return select(hit, { add: d.add });
  }
  if (d.mode === 'draw') {
    const b = d.box && d.box.w > 0.3 && d.box.h > 0.3 ? d.box : { x: d.px, y: d.py, w: 10, h: 10 };
    const make = d.kind === 'ellipse' ? makeEllipse : makeRect;
    addElement(make({ x: round(b.x, 3), y: round(b.y, 3), w: round(b.w, 3), h: round(b.h, 3) }), { keepTool: true });
    return;
  }
  renderStage();
  renderProps();
}

function finishPen(closed) {
  const pts = state.pen?.points || [];
  state.pen = null;
  if (pts.length < 2) return renderStage();
  const cmds = pts.map(([x, y], i) => ({ type: i ? 'L' : 'M', x, y }));
  if (closed) cmds.push({ type: 'Z' });
  const b = pathBounds(cmds);
  const el = makeVector({
    name: closed ? 'Drawn shape' : pts.length === 2 ? 'Line' : 'Drawn path',
    op: 'score',
    open: !closed || undefined,
    x: round(b.x, 3),
    y: round(b.y, 3),
    w: round(b.w, 3),
    h: round(b.h, 3),
    paths: cmds,
    bounds: b,
  });
  addElement(el, { keepTool: true });
}

// ---------- keyboard ----------

function onKey(evt) {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.querySelector('dialog[open]');
  const mod = evt.ctrlKey || evt.metaKey;
  const k = evt.key.toLowerCase();
  if (mod && k === 's') {
    evt.preventDefault();
    return saveProject();
  }
  if (mod && k === 'o') {
    evt.preventDefault();
    return openProject();
  }
  if (mod && k === 'e') {
    evt.preventDefault();
    return showExportDialog(evt.shiftKey ? { bulk: true } : {});
  }
  if (typing) return;
  if (evt.key === ' ') {
    spaceDown = true;
    $('#stage').style.cursor = 'grab';
    evt.preventDefault();
    return;
  }
  if (mod && k === 'z') {
    evt.preventDefault();
    return evt.shiftKey ? redo() : undo();
  }
  if (mod && k === 'y') {
    evt.preventDefault();
    return redo();
  }
  if (mod && k === 'd') {
    evt.preventDefault();
    return duplicate();
  }
  if (mod && k === 'a') {
    evt.preventDefault();
    return select(els().map((e) => e.id));
  }
  if (mod && k === 'g') {
    evt.preventDefault();
    return evt.shiftKey ? ungroupSelected() : groupSelected();
  }
  if (mod && k === 'c') {
    if (copySelection(false)) evt.preventDefault();
    return;
  }
  if (mod && k === 'x') {
    if (copySelection(true)) evt.preventDefault();
    return;
  }
  // Ctrl+V is handled by the paste event (images from other apps, or items)
  if (!mod) {
    const tools = { v: 'select', p: 'pen', r: 'rect', e: 'ellipse' };
    if (tools[k]) return setTool(tools[k]);
  }
  if (evt.key === 'Enter' && state.pen) return finishPen(false);
  if (evt.key === 'Escape') {
    if (state.pen) {
      state.pen = null;
      return renderStage();
    }
    if (state.tool !== 'select') return setTool('select');
    return select(null);
  }
  const sel = selectedEls().filter((e) => !e.locked);
  if (!sel.length) return;
  if (evt.key === 'Delete' || evt.key === 'Backspace') {
    evt.preventDefault();
    return removeSelected();
  }
  const step = evt.shiftKey ? 1 : state.snap || 0.1;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (moves[evt.key]) {
    evt.preventDefault();
    checkpoint('nudge');
    shift(sel, ...moves[evt.key]);
    refresh();
  }
}

function setTool(t) {
  state.tool = t;
  state.pen = null;
  syncSideToggle();
  renderStage();
}

async function onPaste(evt) {
  if (/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName) || document.querySelector('dialog[open]')) return;
  const files = [...(evt.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/'));
  if (files.length) {
    evt.preventDefault();
    const src = await platform.readAsDataURL(files[0].getAsFile());
    return placeImage(src, 'Pasted image');
  }
  const text = evt.clipboardData?.getData('text/plain');
  if (text && text.trim().startsWith('<svg')) {
    evt.preventDefault();
    try {
      const res = importSvg(text);
      const el = makeVector({ name: 'Pasted vector', paths: res.paths, bounds: res.bounds, fillRule: res.fillRule, w: round(Math.min(res.bounds.w, card().w * 0.5), 3) });
      el.h = round((el.w * res.bounds.h) / (res.bounds.w || 1), 3);
      centerOnCard(el, el.w, el.h);
      return addElement(el);
    } catch (e) {
      return toast(e.message);
    }
  }
  if (pasteInternal()) evt.preventDefault();
}

// ---------- wiring ----------

function wire() {
  $('#btnNew').onclick = showNewDialog;
  $('#btnOpen').onclick = openProject;
  $('#btnSave').onclick = saveProject;
  $('#btnUndo').onclick = undo;
  $('#btnRedo').onclick = redo;
  $('#btnZoomIn').onclick = () => zoomBy(1.25);
  $('#btnZoomOut').onclick = () => zoomBy(0.8);
  $('#btnZoomFit').onclick = fitZoom;
  $('#btnExport').onclick = () => showExportDialog();
  $('#btnBulk').onclick = () => showExportDialog({ bulk: true });
  $('#btnSettings').onclick = () => showSettings('laser');
  for (const b of document.querySelectorAll('#dlgSettings [data-tab]')) b.onclick = () => setSettingsTab(b.dataset.tab);
  $('#btnSaveKey').onclick = saveKey;
  $('#btnForgetKey').onclick = forgetKey;
  $('#settingsForm').key.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveKey();
    }
  });
  $('#btnMachine').onclick = toggleMachinePanel;
  $('#mClose').onclick = toggleMachinePanel;
  $('#mConnect').onclick = () => machineAction(() => (machine.connected ? machine.disconnect() : machine.connect()), 'Connect');
  $('#mStart').onclick = startJob;
  $('#mPause').onclick = () => (machine.job?.paused ? machine.resume() : machine.pause());
  $('#mStop').onclick = () => machineAction(() => machine.stop(), 'Stop');
  for (const b of document.querySelectorAll('[data-jog]')) {
    b.onclick = () => {
      const [dx, dy] = b.dataset.jog.split(',').map(Number);
      const step = parseFloat($('#mStep').value);
      machineAction(() => machine.jog(dx * step, dy * step, parseFloat($('#mFeed').value)), 'Jog');
    };
  }
  for (const b of document.querySelectorAll('[data-m]')) {
    const actions = {
      home: () => machine.home(),
      unlock: () => machine.unlock(),
      origin: () => machine.setOrigin(),
      frame: () => {
        const layout = sheetLayout(card(), null);
        return machine.frame(round(layout.w, 3), round(layout.h, 3), { feed: parseFloat($('#mFeed').value) });
      },
    };
    b.onclick = () => machineAction(actions[b.dataset.m], b.textContent.trim());
  }
  $('#mCmd').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.value.trim()) return;
    const cmd = e.target.value.trim();
    e.target.value = '';
    machineAction(() => machine.send(cmd), cmd);
  });
  $('#btnImagine').onclick = imagine;
  $('#btnFromPicture').onclick = makePictureEditableNew;
  $('#btnGrid').onclick = () => {
    state.grid = !state.grid;
    $('#btnGrid').classList.toggle('active', state.grid);
    renderStage();
  };
  $('#snapSel').onchange = (e) => {
    state.snap = parseFloat(e.target.value) || 0;
    renderStage();
  };
  $('#settingsForm').addEventListener('submit', (e) => {
    if (e.submitter?.value === 'ok') saveLaserSettings();
  });
  $('#exportForm').addEventListener('submit', (e) => {
    if (e.submitter?.value === 'ok') {
      doExport().catch((err) => {
        console.error(err);
        toast(`Export failed: ${err.message}`);
      });
    }
  });
  for (const b of document.querySelectorAll('#sideToggle button')) {
    b.onclick = () => {
      state.side = b.dataset.side;
      state.sel.clear();
      renderAll();
    };
  }
  for (const b of document.querySelectorAll('#toolBar button')) b.onclick = () => setTool(b.dataset.tool);
  for (const b of document.querySelectorAll('[data-add]')) b.onclick = () => onAdd(b.dataset.add);
  $('#layerList').addEventListener('click', (e) => {
    const eye = e.target.closest('[data-eye]');
    const lock = e.target.closest('[data-lock]');
    if (eye || lock) {
      const el = els().find((x) => x.id === (eye || lock).dataset.eye || x.id === (eye || lock).dataset.lock);
      checkpoint();
      if (eye) el.hidden = !el.hidden;
      else el.locked = !el.locked || undefined;
      refresh();
      return;
    }
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey) select(li.dataset.id, { toggle: true });
    else {
      // the layer list selects single items, even inside groups
      state.sel = new Set([li.dataset.id]);
      renderStage();
      renderLayers();
      renderProps();
    }
  });
  const stage = $('#stage');
  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerup', onPointerUp);
  stage.addEventListener('pointercancel', onPointerUp);
  stage.addEventListener('pointerleave', () => {
    state.cursor = null;
    renderStatus();
  });
  stage.addEventListener('dblclick', (e) => {
    if (state.tool === 'pen' && state.pen?.points.length > 1) finishPen(false);
    else if (state.tool === 'select' && e.target.classList.contains('hit')) {
      // double-click a grouped item to pick just that item
      state.sel = new Set([e.target.dataset.id]);
      renderStage();
      renderLayers();
      renderProps();
    }
  });
  $('#stageWrap').addEventListener(
    'wheel',
    (e) => {
      // scroll = zoom at the cursor (like LightBurn); Shift+scroll = pan sideways
      if (e.shiftKey) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e);
    },
    { passive: false }
  );
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') {
      spaceDown = false;
      renderStage();
    }
  });
  document.addEventListener('paste', onPaste);
  window.addEventListener('resize', () => renderStage());
  window.addEventListener('beforeunload', (e) => {
    if (state.dirty && !platform.isDesktop) e.preventDefault();
  });
  if (window.lcx?.onMenu) {
    window.lcx.onMenu((cmd) => {
      const map = {
        new: showNewDialog,
        open: openProject,
        save: saveProject,
        export: () => showExportDialog(),
        bulk: () => showExportDialog({ bulk: true }),
        undo,
        redo,
      };
      map[cmd]?.();
    });
  }
}

const SPLASH_MS = 3000;
const startedAt = performance.now();

// Hides the splash, then opens the start screen.
function hideSplash() {
  const el = $('#splash');
  if (!el) return showNewDialog({ welcome: true });
  // the desktop app already showed a splash window: skip the overlay
  const wait = platform.isDesktop ? 0 : Math.max(0, SPLASH_MS - (performance.now() - startedAt));
  setTimeout(() => {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 600);
    showNewDialog({ welcome: true });
  }, wait);
}

async function init() {
  wire();
  await loadBuiltInFonts();
  renderAll();
  fitZoom();
  hideSplash();
  refreshAiStatus();
  window.__lcx = { state, ctx, renderAll, layoutToElements, select }; // handy for debugging & tests
}

init();
