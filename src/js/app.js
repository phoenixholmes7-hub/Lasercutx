// LaserCutX editor UI.
import * as opentype from '../vendor/opentype.mjs';
import qrcode from '../vendor/qrcode.mjs';
import { toSvgD, invert, applyPoint, rectPath } from './geometry.js';
import {
  CARD_PRESETS,
  OPS,
  MATERIALS,
  FONTS,
  FORMATS,
  TEMPLATES,
  newProject,
  newId,
  formatText,
  elementGeometry,
  makeText,
  makeRect,
  makeEllipse,
  makeChip,
  makeQr,
  makeImage,
  makeVector,
  makeErase,
} from './model.js';
import { toSVG, toDXF, toRasterSVG } from './exporters.js';
import * as platform from './platform.js';
import { loadImage, preloadImages, bakedImageSrc, thresholdCanvas, traceImage, svgToPng, importSvg } from './imaging.js';

// qrcode-generator only handles Latin-1 by default; encode text as UTF-8.
qrcode.stringToBytes = (s) => Array.from(new TextEncoder().encode(s));

const $ = (s) => document.querySelector(s);
const PAD = 6; // mm of workspace around the card
const OP_LABELS = { ...Object.fromEntries(Object.entries(OPS).map(([k, v]) => [k, v.label])), none: 'Guide only (not exported)' };

const state = {
  project: newProject('business'),
  side: 'front',
  selId: null,
  zoom: 8, // screen px per mm
  fonts: {}, // file/custom key -> opentype.Font
  undo: [],
  redo: [],
  lastChangeKey: null,
  lastChangeAt: 0,
  dirty: false,
  trace: { threshold: 128, invert: false, pxPerMm: 12 },
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
const selected = () => els().find((e) => e.id === state.selId) || null;
const card = () => state.project.card;
const round = (n, p = 2) => Math.round(n * 10 ** p) / 10 ** p;

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
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

// ---------- rendering: stage ----------

function renderStage() {
  const c = card();
  const mat = MATERIALS[c.material] || MATERIALS.silver;
  const svg = $('#stage');
  const W = c.w + PAD * 2;
  const H = c.h + PAD * 2;
  svg.setAttribute('viewBox', `${-PAD} ${-PAD} ${W} ${H}`);
  svg.setAttribute('width', Math.round(W * state.zoom));
  svg.setAttribute('height', Math.round(H * state.zoom));
  $('#zoomLabel').textContent = `${Math.round((state.zoom / 8) * 100)}%`;

  const outline = toSvgD(rectPath(0, 0, c.w, c.h, c.radius));
  const images = [];
  const erases = [];
  const vectors = [];
  const hits = [];
  let selBox = '';

  for (const el of els()) {
    const geo = elementGeometry(el, ctx);
    const m = geo.matrix.map((n) => round(n, 5)).join(' ');
    const guide = el.op === 'none';
    if (!el.hidden) {
      if (geo.raster) {
        if (geo.raster.src) {
          images.push(
            `<image href="${geo.raster.src}" x="0" y="0" width="${geo.w}" height="${geo.h}" preserveAspectRatio="none" transform="matrix(${m})" opacity="${guide ? 0.45 : 0.9}" filter="url(#gray)"/>`
          );
        }
      } else if (el.type === 'erase') {
        erases.push(
          `<rect x="0" y="0" width="${geo.w}" height="${geo.h}" transform="matrix(${m})" fill="url(#mat)" stroke="#ff9f1a" stroke-width="0.12" stroke-dasharray="0.6 0.4"/>`
        );
      } else if (geo.cmds.length) {
        const d = toSvgD(geo.cmds, 3);
        const o = guide ? ' opacity="0.35"' : '';
        if (el.op === 'cut') {
          vectors.push(`<path d="${d}" fill="#0b0c0e" fill-opacity="0.85" stroke="#ff3b30" stroke-width="0.15" stroke-dasharray="0.8 0.4"${o}/>`);
        } else if (el.op === 'score') {
          vectors.push(`<path d="${d}" fill="none" stroke="${mat.mark}" stroke-width="0.18"${o}/>`);
        } else {
          vectors.push(`<path d="${d}" fill="${mat.mark}" fill-rule="${geo.fillRule}"${o}/>`);
        }
      }
    }
    hits.push(`<rect class="hit" data-id="${el.id}" x="0" y="0" width="${Math.max(geo.w, 0.5)}" height="${Math.max(geo.h, 0.5)}" transform="matrix(${m})" fill="transparent" style="cursor:move"/>`);
    if (el.id === state.selId) {
      const hs = 1.6 * (8 / state.zoom);
      const [hx, hy] = applyPoint(geo.matrix, geo.w, geo.h);
      selBox = `<rect x="0" y="0" width="${geo.w}" height="${geo.h}" transform="matrix(${m})" fill="none" stroke="#3d8bfd" stroke-width="${0.12 * (8 / state.zoom)}" stroke-dasharray="0.6 0.3" pointer-events="none"/>
        <rect class="handle" x="${hx - hs / 2}" y="${hy - hs / 2}" width="${hs}" height="${hs}" fill="#fff" stroke="#3d8bfd" stroke-width="${0.15 * (8 / state.zoom)}" style="cursor:nwse-resize"/>`;
    }
  }

  const safe = 2.5;
  svg.innerHTML = `
    <defs>
      <linearGradient id="mat" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${mat.base2}"/><stop offset="0.55" stop-color="${mat.base}"/><stop offset="1" stop-color="${mat.base2}"/>
      </linearGradient>
      <clipPath id="cardClip"><path d="${outline}"/></clipPath>
      <filter id="gray"><feColorMatrix type="saturate" values="0"/></filter>
    </defs>
    <rect class="bg" x="${-PAD}" y="${-PAD}" width="${W}" height="${H}" fill="transparent"/>
    <path d="${outline}" fill="url(#mat)" stroke="${c.includeOutline ? '#ff3b30' : '#0006'}" stroke-width="0.15" style="filter:drop-shadow(0 0.6px 1.2px #0008)"/>
    <rect x="${safe}" y="${safe}" width="${c.w - 2 * safe}" height="${c.h - 2 * safe}" fill="none" stroke="#3d8bfd" stroke-opacity="0.35" stroke-width="0.08" stroke-dasharray="1 0.6" rx="${Math.max(0, c.radius - safe)}" pointer-events="none"/>
    <g clip-path="url(#cardClip)">${images.join('')}${erases.join('')}</g>
    <g>${vectors.join('')}</g>
    <g>${hits.join('')}</g>
    ${selBox}`;
}

// ---------- rendering: layers ----------

function renderLayers() {
  const ul = $('#layerList');
  const list = [...els()].reverse();
  if (!list.length) {
    ul.innerHTML = '<li class="empty" style="color:var(--muted);cursor:default">Nothing on this side yet – use Add above.</li>';
    return;
  }
  ul.innerHTML = list
    .map((el) => {
      const color = el.type === 'erase' ? '#ff9f1a' : OPS[el.op]?.color || '#777';
      const label = el.name || el.type;
      return `<li data-id="${el.id}" class="${el.id === state.selId ? 'sel' : ''} ${el.hidden ? 'hidden' : ''}">
        <span class="dot" style="background:${color}"></span>
        <span class="nm" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
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
        if (state.side !== side || state.selId !== el.id) {
          state.side = side;
          state.selId = el.id;
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

// ---------- rendering: properties ----------

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
    if (opts.type === 'number') {
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

function buttons(parent, list) {
  const d = document.createElement('div');
  d.className = 'btnrow';
  for (const [text, fn, cls] of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    if (cls) b.className = cls;
    b.addEventListener('click', fn);
    d.appendChild(b);
  }
  parent.appendChild(d);
  return d;
}

function heading(parent, text) {
  const h = document.createElement('h2');
  h.textContent = text;
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

function renderProps() {
  const p = $('#props');
  p.innerHTML = '';
  const el = selected();
  if (!el) return renderCardProps(p);

  heading(p, el.type === 'erase' ? 'Erase box' : `${el.type === 'qr' ? 'QR code' : el.type[0].toUpperCase() + el.type.slice(1)} properties`);
  field(p, 'Name', el.name, setter(el, 'name', () => renderQuickFill()));

  if (el.type !== 'erase') {
    const ops = { ...OP_LABELS };
    field(p, 'Laser operation', el.op, setter(el, 'op'), { options: ops });
  }

  if (el.type === 'text') {
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
  }

  if (el.type === 'qr') {
    field(p, 'QR content (link, text, phone…)', el.data, setter(el, 'data', () => renderQuickFill()), { textarea: true });
    field(p, 'Error correction', el.ecl, setter(el, 'ecl'), {
      options: { L: 'Low (7%)', M: 'Medium (15%)', Q: 'Quartile (25%)', H: 'High (30%)' },
    });
  }

  const geo = elementGeometry(el, ctx);
  const r = row(p);
  field(r, 'X (mm)', el.x, setter(el, 'x'), { type: 'number', step: 0.1 });
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

  buttons(p, [
    ['Center ↔', () => center('x')],
    ['Center ↕', () => center('y')],
  ]);
  buttons(p, [
    ['Bring forward', () => reorder(1)],
    ['Send back', () => reorder(-1)],
  ]);
  buttons(p, [
    ['Duplicate', duplicate],
    [`Move to ${state.side === 'front' ? 'back' : 'front'}`, moveToOtherSide],
    ['Delete', removeSelected, 'danger'],
  ]);

  if (el.type === 'image') renderTraceTools(p, el);
  if (el.type === 'vector') {
    field(p, 'Fill rule', el.fillRule || 'nonzero', setter(el, 'fillRule'), { options: { nonzero: 'Non-zero', evenodd: 'Even-odd (fixes filled holes)' } });
  }
  if (el.type === 'erase') {
    tip(p, 'An <b>Erase box</b> whites-out the part of any image underneath it – use it to hide an old name or card number, then type the new one with a Text item on top. It is applied when you trace or export the image and is never cut or engraved itself.');
  }
}

function renderTraceTools(p, el) {
  heading(p, 'Edit & convert image');
  tip(p, '1. Put <b>Erase boxes</b> over old names / numbers.<br>2. Add new <b>Text</b> on top (it appears in Quick Fill).<br>3. Convert the image to vector so the SVG/DXF has clean laser paths.');
  buttons(p, [['＋ Erase box here', () => addErase(el)]]);
  const t = state.trace;
  const canvasHost = document.createElement('div');
  const updatePreview = () => {
    try {
      const { canvas } = thresholdCanvas(el, els(), { ...t, pxPerMm: Math.min(t.pxPerMm, 8) });
      canvas.className = 'trace-preview';
      canvasHost.replaceChildren(canvas);
    } catch (e) {
      canvasHost.textContent = 'Preview unavailable';
    }
  };
  field(p, `Threshold`, t.threshold, (v) => {
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
  buttons(p, [['Convert to vector (trace)', () => convertImage(el), 'primary']]);
  tip(p, 'Black in the preview = engraved. Prefer raster engraving instead? Leave the image as is – it is embedded in SVG and PNG exports (DXF holds vectors only).');
  loadImage(el.src).then(updatePreview, () => {});
}

function renderCardProps(p) {
  const c = card();
  heading(p, 'Card');
  field(p, 'Size', c.preset, (v) => {
    checkpoint();
    c.preset = v;
    if (v !== 'custom') Object.assign(c, { w: CARD_PRESETS[v].w, h: CARD_PRESETS[v].h, radius: CARD_PRESETS[v].radius });
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
  field(r, 'Width (mm)', c.w, onSize('w'), { type: 'number', step: 0.1, min: 10 });
  field(r, 'Height (mm)', c.h, onSize('h'), { type: 'number', step: 0.1, min: 10 });
  field(p, 'Corner radius (mm)', c.radius, (v) => {
    checkpoint('card-r');
    c.radius = v;
    renderStage();
  }, { type: 'number', step: 0.1, min: 0 });
  field(p, 'Material preview', c.material, (v) => {
    checkpoint();
    c.material = v;
    renderStage();
  }, { options: Object.fromEntries(Object.entries(MATERIALS).map(([k, v]) => [k, v.label])) });
  field(p, 'Cut card outline (red layer)', c.includeOutline, (v) => {
    checkpoint();
    c.includeOutline = v;
    renderStage();
  }, { type: 'checkbox' });
  tip(
    p,
    `<b>How it works</b><br>
    • <b>Quick Fill</b> (left) edits every name, number and QR link.<br>
    • Card numbers group themselves in 4s, expiry becomes MM/YY.<br>
    • Import a picture of a card design with <b>Image</b>, hide old details with <b>Erase box</b>, then add your own text.<br>
    • Colours on export: <b>black</b> = engrave fill, <b>blue</b> = line engrave, <b>red</b> = cut.<br>
    • Keep important items inside the dashed safe area.`
  );
}

// Re-renders everything except panels that currently have keyboard focus
// (so typing is not interrupted).
function refresh() {
  renderStage();
  renderLayers();
  const active = document.activeElement;
  if (!$('#quickFill').contains(active)) renderQuickFill();
  if (!$('#props').contains(active)) renderProps();
}

function renderAll() {
  loadCustomFonts();
  if (!els().some((e) => e.id === state.selId)) state.selId = null;
  syncSideToggle();
  renderStage();
  renderLayers();
  renderQuickFill();
  renderProps();
}

function syncSideToggle() {
  for (const b of document.querySelectorAll('#sideToggle button')) b.classList.toggle('active', b.dataset.side === state.side);
}

// ---------- actions ----------

function select(id) {
  state.selId = id;
  renderStage();
  renderLayers();
  renderProps();
}

function addElement(el) {
  checkpoint();
  els().push(el);
  state.selId = el.id;
  renderAll();
}

function centerOnCard(el, w, h) {
  el.x = round((card().w - w) / 2, 2);
  el.y = round((card().h - h) / 2, 2);
}

async function onAdd(kind) {
  const c = card();
  switch (kind) {
    case 'text': {
      const el = makeText({ text: 'New text', sizePt: 10 });
      const g = elementGeometry(el, ctx);
      centerOnCard(el, g.w, g.h);
      return addElement(el);
    }
    case 'rect': {
      const el = makeRect();
      centerOnCard(el, el.w, el.h);
      return addElement(el);
    }
    case 'ellipse': {
      const el = makeEllipse();
      centerOnCard(el, el.w, el.h);
      return addElement(el);
    }
    case 'chip':
      return addElement(makeChip());
    case 'qr': {
      const el = makeQr();
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
  if (!file) return;
  const src = await platform.readAsDataURL(file);
  let img;
  try {
    img = await loadImage(src);
  } catch {
    return toast('Could not read that image.');
  }
  const c = card();
  const aspect = img.naturalWidth / img.naturalHeight;
  const el = makeImage({ name: file.name.replace(/\.[^.]+$/, ''), src });
  if (Math.abs(aspect - c.w / c.h) / (c.w / c.h) < 0.12) {
    // looks like a whole card design: fill the card and keep it as a guide
    Object.assign(el, { x: 0, y: 0, w: c.w, h: c.h });
    toast('Image fills the card. Use Erase boxes + Text to change names or numbers, then convert or export.', 4500);
  } else {
    const maxW = c.w * 0.5;
    const maxH = c.h * 0.6;
    el.w = Math.min(maxW, maxH * aspect);
    el.h = el.w / aspect;
    centerOnCard(el, el.w, el.h);
  }
  el.w = round(el.w, 3);
  el.h = round(el.h, 3);
  addElement(el);
  // keep images behind everything else
  moveToIndex(el, 0);
}

function moveToIndex(el, idx) {
  const list = els();
  list.splice(list.indexOf(el), 1);
  list.splice(idx, 0, el);
  renderAll();
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
    paths: res.cmds,
    bounds: { x: 0, y: 0, w: el.w, h: el.h },
  });
  const list = els();
  const idx = list.indexOf(el);
  // keep the original image as a hidden guide so the user can re-trace later
  el.hidden = true;
  el.op = 'none';
  list.splice(idx + 1, 0, vec);
  // erase boxes have done their job for this image
  state.selId = vec.id;
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
  } catch (e) {
    toast('That font could not be loaded (WOFF2 is not supported – use TTF, OTF or WOFF).', 4500);
    return null;
  }
}

function center(axis) {
  const el = selected();
  if (!el) return;
  checkpoint();
  const g = elementGeometry(el, ctx);
  if (axis === 'x') el.x = round((card().w - g.w) / 2, 3);
  else el.y = round((card().h - g.h) / 2, 3);
  refresh();
  renderProps();
}

function reorder(dir) {
  const el = selected();
  if (!el) return;
  const list = els();
  const i = list.indexOf(el);
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  checkpoint();
  [list[i], list[j]] = [list[j], list[i]];
  renderStage();
  renderLayers();
}

function duplicate() {
  const el = selected();
  if (!el) return;
  const copy = { ...JSON.parse(JSON.stringify(el)), id: newId(), x: el.x + 2, y: el.y + 2, name: `${el.name} copy` };
  addElement(copy);
}

function removeSelected() {
  const el = selected();
  if (!el) return;
  checkpoint();
  els().splice(els().indexOf(el), 1);
  state.selId = null;
  renderAll();
}

function moveToOtherSide() {
  const el = selected();
  if (!el) return;
  checkpoint();
  els().splice(els().indexOf(el), 1);
  state.side = state.side === 'front' ? 'back' : 'front';
  els().push(el);
  renderAll();
}

// ---------- project files ----------

async function saveProject() {
  const name = await platform.saveFile('card-design.lcx', JSON.stringify(state.project, null, 1), {
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
    state.selId = null;
    state.side = 'front';
    await preloadImages(p);
    renderAll();
    fitZoom();
    toast(`Opened ${file.name}`);
  } catch {
    toast('That file is not a LaserCutX project.');
  }
}

function showNewDialog() {
  const dlg = $('#dlgNew');
  const list = $('#templateList');
  const desc = {
    blank: 'Empty card – start from scratch.',
    credit: 'Chip pocket, card number, expiry and name – all editable in Quick Fill.',
    business: 'Name, title, contact details and a QR code.',
  };
  list.innerHTML = '';
  for (const [key, t] of Object.entries(TEMPLATES)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<b>${t.label}</b><span>${desc[key] || ''}</span>`;
    b.onclick = () => {
      checkpoint();
      state.project = newProject(key);
      state.side = 'front';
      state.selId = null;
      dlg.close();
      renderAll();
      fitZoom();
    };
    list.appendChild(b);
  }
  const img = document.createElement('button');
  img.type = 'button';
  img.innerHTML = '<b>From an image of a card…</b><span>Load a picture/scan, cover the old name or number and type your own.</span>';
  img.onclick = async () => {
    dlg.close();
    checkpoint();
    state.project = newProject('blank');
    state.side = 'front';
    state.selId = null;
    renderAll();
    fitZoom();
    await importImage();
  };
  list.appendChild(img);
  dlg.showModal();
}

// ---------- export ----------

function showExportDialog() {
  const dlg = $('#dlgExport');
  const form = $('#exportForm');
  const update = () => {
    const fmt = form.format.value;
    form.querySelector('.png-only').style.display = fmt === 'png' ? '' : 'none';
    const notes = {
      svg: 'Millimetre units – imports at true size. Layers are coloured so LightBurn assigns them automatically.',
      dxf: 'Vector only (images are left out – convert them to vector first). Layers: ENGRAVE, SCORE, CUT.',
      png: 'Black = engrave. DPI is stored in the file so it imports at the correct size.',
    };
    $('#exportNote').textContent = notes[fmt];
  };
  form.format.onchange = update;
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
  await preloadImages(state.project);

  const files = [];
  const skipped = [];
  for (const side of sides) {
    const sideEls = state.project.sides[side];
    const imageSrc = (el) => bakedImageSrc(el, sideEls);
    const base = `card-${side}${mirror ? '-mirrored' : ''}`;
    if (fmt === 'svg') {
      files.push({ name: `${base}.svg`, data: toSVG(state.project, side, ctx, { layers, mirror, imageSrc }) });
    } else if (fmt === 'dxf') {
      const r = toDXF(state.project, side, ctx, { layers, mirror });
      skipped.push(...r.skipped);
      files.push({ name: `${base}.dxf`, data: r.dxf });
    } else {
      const dpi = parseInt(form.dpi.value, 10);
      const svg = toRasterSVG(state.project, side, ctx, { layers, mirror, invert: form.invert.checked, imageSrc });
      files.push({ name: `${base}-${dpi}dpi.png`, data: await svgToPng(svg, card().w, card().h, dpi) });
    }
  }
  const filter = {
    svg: { name: 'SVG', extensions: ['svg'], mime: 'image/svg+xml' },
    dxf: { name: 'DXF', extensions: ['dxf'], mime: 'application/dxf' },
    png: { name: 'PNG image', extensions: ['png'], mime: 'image/png' },
  }[fmt];
  const res = files.length === 1 ? await platform.saveFile(files[0].name, files[0].data, filter) : await platform.saveFiles(files, filter);
  if (!res) return;
  let msg = `Exported ${files.map((f) => f.name).join(', ')}`;
  if (skipped.length) msg += ` – images skipped in DXF: ${skipped.join(', ')}`;
  toast(msg, 4500);
}

// ---------- zoom ----------

function fitZoom() {
  const wrap = $('#stageWrap');
  const c = card();
  const z = Math.min((wrap.clientWidth - 40) / (c.w + PAD * 2), (wrap.clientHeight - 60) / (c.h + PAD * 2));
  state.zoom = Math.max(2, Math.min(40, z));
  renderStage();
}

function zoomBy(f) {
  state.zoom = Math.max(2, Math.min(60, state.zoom * f));
  renderStage();
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

function onPointerDown(evt) {
  const target = evt.target;
  const [px, py] = svgPoint(evt);
  if (target.classList.contains('handle')) {
    const el = selected();
    if (!el) return;
    checkpoint();
    const geo = elementGeometry(el, ctx);
    drag = { mode: 'resize', el, inv: invert(geo.matrix), w0: geo.w, h0: geo.h, size0: el.sizePt };
  } else if (target.classList.contains('hit')) {
    const id = target.dataset.id;
    if (state.selId !== id) select(id);
    const el = selected();
    checkpoint();
    drag = { mode: 'move', el, px, py, x0: el.x, y0: el.y, moved: false };
  } else {
    if (state.selId) select(null);
    return;
  }
  $('#stage').setPointerCapture(evt.pointerId);
  evt.preventDefault();
}

function onPointerMove(evt) {
  if (!drag) return;
  const [px, py] = svgPoint(evt);
  const el = drag.el;
  if (drag.mode === 'move') {
    let nx = drag.x0 + (px - drag.px);
    let ny = drag.y0 + (py - drag.py);
    if (!evt.altKey) {
      nx = Math.round(nx * 10) / 10;
      ny = Math.round(ny * 10) / 10;
    }
    el.x = nx;
    el.y = ny;
    drag.moved = true;
  } else {
    const [lx, ly] = applyPoint(drag.inv, px, py);
    const w = Math.max(0.5, lx);
    const h = Math.max(0.5, ly);
    if (el.type === 'text') {
      el.sizePt = Math.max(1, round(drag.size0 * (w / drag.w0), 1));
    } else if (el.type === 'qr') {
      el.w = el.h = round(Math.max(w, h), 2);
    } else if ((el.type === 'image' || el.type === 'vector') && !evt.shiftKey) {
      const k = Math.max(w / drag.w0, h / drag.h0);
      el.w = round(drag.w0 * k, 3);
      el.h = round(drag.h0 * k, 3);
    } else {
      el.w = round(w, 2);
      el.h = round(h, 2);
    }
  }
  renderStage();
}

function onPointerUp() {
  if (!drag) return;
  if (drag.mode === 'move' && !drag.moved) state.undo.pop(); // a click, not a change
  drag = null;
  renderProps();
}

// ---------- keyboard ----------

function onKey(evt) {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.querySelector('dialog[open]');
  const mod = evt.ctrlKey || evt.metaKey;
  if (mod && evt.key.toLowerCase() === 's') {
    evt.preventDefault();
    return saveProject();
  }
  if (mod && evt.key.toLowerCase() === 'o') {
    evt.preventDefault();
    return openProject();
  }
  if (mod && evt.key.toLowerCase() === 'e') {
    evt.preventDefault();
    return showExportDialog();
  }
  if (typing) return;
  if (mod && evt.key.toLowerCase() === 'z') {
    evt.preventDefault();
    return evt.shiftKey ? redo() : undo();
  }
  if (mod && evt.key.toLowerCase() === 'y') {
    evt.preventDefault();
    return redo();
  }
  if (mod && evt.key.toLowerCase() === 'd') {
    evt.preventDefault();
    return duplicate();
  }
  const el = selected();
  if (!el) return;
  if (evt.key === 'Delete' || evt.key === 'Backspace') {
    evt.preventDefault();
    return removeSelected();
  }
  const step = evt.shiftKey ? 1 : 0.1;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (moves[evt.key]) {
    evt.preventDefault();
    checkpoint(`nudge-${el.id}`);
    el.x = round(el.x + moves[evt.key][0], 3);
    el.y = round(el.y + moves[evt.key][1], 3);
    refresh();
    renderProps();
  }
  if (evt.key === 'Escape') select(null);
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
  $('#btnExport').onclick = showExportDialog;
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
      state.selId = null;
      renderAll();
    };
  }
  for (const b of document.querySelectorAll('[data-add]')) b.onclick = () => onAdd(b.dataset.add);
  $('#layerList').addEventListener('click', (e) => {
    const eye = e.target.closest('[data-eye]');
    if (eye) {
      const el = els().find((x) => x.id === eye.dataset.eye);
      checkpoint();
      el.hidden = !el.hidden;
      refresh();
      return;
    }
    const li = e.target.closest('li[data-id]');
    if (li) select(li.dataset.id);
  });
  const stage = $('#stage');
  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerup', onPointerUp);
  stage.addEventListener('pointercancel', onPointerUp);
  $('#stageWrap').addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.1 : 0.9);
    },
    { passive: false }
  );
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', () => renderStage());
  window.addEventListener('beforeunload', (e) => {
    if (state.dirty && !platform.isDesktop) e.preventDefault();
  });
  if (window.lcx?.onMenu) {
    window.lcx.onMenu((cmd) => {
      const map = { new: showNewDialog, open: openProject, save: saveProject, export: showExportDialog, undo, redo };
      map[cmd]?.();
    });
  }
}

async function init() {
  wire();
  await loadBuiltInFonts();
  renderAll();
  fitZoom();
  window.__lcx = { state, ctx, renderAll }; // handy for debugging
}

init();
