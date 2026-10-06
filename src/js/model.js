// Card project model: presets, element factories, templates and the
// conversion of every element into plain vector geometry (in card mm).
import {
  compose,
  translate,
  rotate,
  scale,
  rectPath,
  ellipsePath,
  transformPath,
  fromOpentype,
  arcToCubics,
  pathBounds,
} from './geometry.js';

export const PT_TO_MM = 25.4 / 72;

// Workspace presets. `kind: 'card'` shows the safe area and cuts the outline by
// default; other presets are general laser projects (signs, coasters, tags…).
export const CARD_PRESETS = {
  iso: { label: 'Credit card – ISO ID-1 (85.60 × 53.98 mm)', w: 85.6, h: 53.98, radius: 3.18, kind: 'card' },
  us: { label: 'US business card (88.9 × 50.8 mm)', w: 88.9, h: 50.8, radius: 3, kind: 'card' },
  eu: { label: 'EU business card (85 × 55 mm)', w: 85, h: 55, radius: 3, kind: 'card' },
  tag: { label: 'Key-chain tag (60 × 25 mm)', w: 60, h: 25, radius: 5, kind: 'piece' },
  coaster: { label: 'Round coaster (Ø 100 mm)', w: 100, h: 100, radius: 0, shape: 'ellipse', kind: 'piece' },
  sign: { label: 'Sign (200 × 100 mm)', w: 200, h: 100, radius: 4, kind: 'piece' },
  bed300: { label: 'Laser bed 300 × 200 mm (free layout)', w: 300, h: 200, radius: 0, kind: 'bed' },
  bed400: { label: 'Laser bed 400 × 400 mm (free layout)', w: 400, h: 400, radius: 0, kind: 'bed' },
  a4: { label: 'A4 sheet (297 × 210 mm)', w: 297, h: 210, radius: 0, kind: 'bed' },
  custom: { label: 'Custom size', w: 85.6, h: 53.98, radius: 3.18, kind: 'piece' },
};

export function applyPreset(card, key) {
  const pr = CARD_PRESETS[key];
  card.preset = key;
  if (!pr || key === 'custom') return;
  Object.assign(card, { w: pr.w, h: pr.h, radius: pr.radius, shape: pr.shape || 'rect', kind: pr.kind });
  // a free laser bed is a work area, not a piece to cut out
  card.includeOutline = pr.kind !== 'bed';
}

// Per-layer machine settings (LightBurn-style "Cuts / Layers"), used for G-code.
export function laserDefaults() {
  return {
    engrave: { output: true, speed: 3000, power: 30, passes: 1, interval: 0.1, bidirectional: true },
    score: { output: true, speed: 1500, power: 40, passes: 1 },
    cut: { output: true, speed: 300, power: 90, passes: 2 },
    image: { output: true, speed: 3000, power: 40, passes: 1, interval: 0.1 },
    machine: { maxS: 1000, travel: 6000, laserMode: 'M4', airAssist: false },
  };
}

// Laser operations. Colours follow the common LightBurn / RDWorks convention so
// layers are recognised automatically on import.
export const OPS = {
  engrave: { label: 'Engrave (fill)', color: '#000000', dxfLayer: 'ENGRAVE', aci: 7 },
  score: { label: 'Line engrave (outline)', color: '#0000FF', dxfLayer: 'SCORE', aci: 5 },
  cut: { label: 'Cut through', color: '#FF0000', dxfLayer: 'CUT', aci: 1 },
};

export const MATERIALS = {
  silver: { label: 'Stainless / silver', base: '#c9ccd1', base2: '#eef0f3', mark: '#3a3d42' },
  black: { label: 'Black metal', base: '#1d1e21', base2: '#3a3b40', mark: '#c5c8cc' },
  gold: { label: 'Gold', base: '#c9a548', base2: '#f1dc94', mark: '#5b4614' },
  rose: { label: 'Rose gold', base: '#d29c8a', base2: '#f3d1c4', mark: '#6b3a2c' },
  blue: { label: 'Anodised blue', base: '#23406e', base2: '#3e66a8', mark: '#d7dde6' },
  wood: { label: 'Wood / plywood', base: '#c89b63', base2: '#e2c08f', mark: '#4a2c12' },
  acrylic: { label: 'Clear acrylic', base: '#d9eef5', base2: '#f4fbfd', mark: '#7a95a3' },
  blackacrylic: { label: 'Black acrylic', base: '#121316', base2: '#2a2c31', mark: '#e8eaee' },
  leather: { label: 'Leather', base: '#8a5634', base2: '#a8714a', mark: '#2b170a' },
  slate: { label: 'Slate', base: '#3b4046', base2: '#565c63', mark: '#d4d7da' },
  paper: { label: 'Paper / card stock', base: '#f3f1ea', base2: '#ffffff', mark: '#3a3a3a' },
};

export const FONTS = [
  { key: 'roboto', label: 'Roboto', files: { 400: 'roboto-400.woff', 700: 'roboto-700.woff' } },
  { key: 'montserrat', label: 'Montserrat', files: { 400: 'montserrat-400.woff', 700: 'montserrat-700.woff' } },
  { key: 'playfair', label: 'Playfair Display', files: { 400: 'playfair-display-400.woff', 700: 'playfair-display-700.woff' } },
  { key: 'mono', label: 'Roboto Mono', files: { 400: 'roboto-mono-400.woff', 700: 'roboto-mono-700.woff' } },
  { key: 'orbitron', label: 'Orbitron', files: { 400: 'orbitron-400.woff', 700: 'orbitron-700.woff' } },
  { key: 'greatvibes', label: 'Great Vibes (script)', files: { 400: 'great-vibes-400.woff' } },
];

let idCounter = 0;
export const newId = () => `el${Date.now().toString(36)}${(idCounter++).toString(36)}`;

// ---------- element factories ----------

export function makeText(props = {}) {
  return {
    id: newId(),
    type: 'text',
    name: 'Text',
    op: 'engrave',
    x: 10,
    y: 10,
    rotation: 0,
    text: 'Your text',
    font: 'montserrat',
    weight: 400,
    sizePt: 10,
    letterSpacing: 0,
    lineHeight: 1.2,
    align: 'left',
    ...props,
  };
}

export function makeRect(props = {}) {
  return { id: newId(), type: 'rect', name: 'Rectangle', op: 'score', x: 10, y: 10, w: 20, h: 12, radius: 0, rotation: 0, ...props };
}

export function makeEllipse(props = {}) {
  return { id: newId(), type: 'ellipse', name: 'Circle', op: 'score', x: 10, y: 10, w: 12, h: 12, rotation: 0, ...props };
}

export function makeChip(props = {}) {
  return makeRect({ name: 'EMV chip pocket', op: 'engrave', x: 8.6, y: 18.4, w: 12.6, h: 11.4, radius: 1.6, ...props });
}

export function makePolygon(props = {}) {
  return { id: newId(), type: 'polygon', name: 'Polygon', op: 'score', x: 10, y: 10, w: 14, h: 14, rotation: 0, sides: 6, star: false, inner: 0.5, ...props };
}

export function makeStar(props = {}) {
  return makePolygon({ name: 'Star', sides: 5, star: true, inner: 0.45, ...props });
}

export function makeQr(props = {}) {
  return { id: newId(), type: 'qr', name: 'QR code', op: 'engrave', x: 60, y: 20, w: 18, h: 18, rotation: 0, data: 'https://example.com', ecl: 'M', ...props };
}

export function makeImage(props = {}) {
  return { id: newId(), type: 'image', name: 'Image', op: 'engrave', x: 10, y: 10, w: 20, h: 20, rotation: 0, src: '', ...props };
}

// White box that hides part of any image underneath it (e.g. an old name or
// card number on a scanned design). It is applied when images are exported
// or traced and is never sent to the laser itself.
export function makeErase(props = {}) {
  return { id: newId(), type: 'erase', name: 'Erase box', op: 'none', x: 10, y: 10, w: 25, h: 6, rotation: 0, ...props };
}

export function makeVector(props = {}) {
  return { id: newId(), type: 'vector', name: 'Logo', op: 'engrave', x: 10, y: 10, w: 20, h: 20, rotation: 0, paths: [], bounds: { x: 0, y: 0, w: 1, h: 1 }, fillRule: 'nonzero', ...props };
}

// ---------- projects & templates ----------

export function newProject(template = 'blank') {
  const p = {
    format: 'lasercutx',
    version: 1,
    card: { preset: 'iso', ...pick(CARD_PRESETS.iso, ['w', 'h', 'radius', 'kind']), shape: 'rect', material: 'silver', includeOutline: true },
    sides: { front: [], back: [] },
    customFonts: [],
    laser: laserDefaults(),
  };
  const t = TEMPLATES[template];
  if (t) t.build(p);
  return p;
}

function pick(o, keys) {
  const r = {};
  for (const k of keys) r[k] = o[k];
  return r;
}

// ---------- decorative shapes used by templates ----------

// A vector element whose `cmds` are already in local mm (0..w, 0..h).
function shape(name, op, x, y, w, h, cmds, props = {}) {
  return makeVector({ name, op, x, y, w, h, paths: cmds, bounds: { x: 0, y: 0, w, h }, ...props });
}

const line = (x1, y1, x2, y2) => [
  { type: 'M', x: x1, y: y1 },
  { type: 'L', x: x2, y: y2 },
];

// Chip contact pattern drawn as engraved lines.
export function makeChipArt(props = {}) {
  const w = 11.6;
  const h = 9.2;
  const a = w * 0.34;
  const b = w * 0.66;
  const cmds = [
    ...rectPath(0, 0, w, h, 1.5),
    ...rectPath(a, h * 0.22, b - a, h * 0.56, 0.8),
    ...line(a, 0, a, h * 0.22),
    ...line(b, 0, b, h * 0.22),
    ...line(a, h * 0.78, a, h),
    ...line(b, h * 0.78, b, h),
    ...line(0, h / 3, a, h / 3),
    ...line(0, (2 * h) / 3, a, (2 * h) / 3),
    ...line(b, h / 3, w, h / 3),
    ...line(b, (2 * h) / 3, w, (2 * h) / 3),
    ...line(w / 2, 0, w / 2, h * 0.22),
    ...line(w / 2, h * 0.78, w / 2, h),
  ];
  return shape('Chip (contact art)', 'score', 9, 17, w, h, cmds, props);
}

// Contactless "waves" symbol.
export function makeContactless(props = {}) {
  const w = 5.2;
  const h = 6.4;
  const cmds = [];
  const sweep = (40 * Math.PI) / 180;
  for (let i = 0; i < 4; i++) {
    const r = 1.4 + i * 1.25;
    const x1 = r * Math.cos(-sweep);
    const y1 = h / 2 + r * Math.sin(-sweep);
    const x2 = r * Math.cos(sweep);
    const y2 = h / 2 + r * Math.sin(sweep);
    cmds.push({ type: 'M', x: x1, y: y1 }, ...arcToCubics(x1, y1, r, r, 0, 0, 1, x2, y2));
  }
  return shape('Contactless symbol', 'score', 74, 18, w, h, cmds, props);
}

// Ribbon banner with notched ends.
function ribbon(name, x, y, w, h) {
  const n = Math.min(1.4, w / 6);
  const cmds = [
    { type: 'M', x: 0, y: 0 },
    { type: 'L', x: w, y: 0 },
    { type: 'L', x: w - n, y: h / 2 },
    { type: 'L', x: w, y: h },
    { type: 'L', x: 0, y: h },
    { type: 'L', x: n, y: h / 2 },
    { type: 'Z' },
  ];
  return shape(name, 'score', x, y, w, h, cmds);
}

// Fine double frame just inside the card edge.
function doubleBorder(card, inset = 1.8, gap = 0.7) {
  return [
    makeRect({ name: 'Border (outer)', op: 'score', x: inset, y: inset, w: card.w - 2 * inset, h: card.h - 2 * inset, radius: Math.max(0.5, card.radius - inset) }),
    makeRect({
      name: 'Border (inner)',
      op: 'score',
      x: inset + gap,
      y: inset + gap,
      w: card.w - 2 * (inset + gap),
      h: card.h - 2 * (inset + gap),
      radius: Math.max(0.3, card.radius - inset - gap),
    }),
  ];
}

// Centred text helper (x is the centre line).
const ctext = (props) => makeText({ anchor: 'center', align: 'center', ...props });

export const TEMPLATES = {
  blank: { label: 'Blank card', desc: 'Empty card – start from scratch.', build() {} },

  // ----- credit cards -----
  credit: {
    group: 'Credit cards',
    label: 'Classic metal credit card',
    desc: 'Chip pocket, card number, expiry, name and network circles. Front + back.',
    build(p) {
      p.card.material = 'black';
      p.sides.front = [
        makeText({ name: 'Bank name', text: 'METAL BANK', font: 'montserrat', weight: 700, sizePt: 11, letterSpacing: 0.6, x: 7, y: 6 }),
        makeChip(),
        makeText({ name: 'Card number', format: 'cardnumber', text: '4000 1234 5678 9010', font: 'mono', weight: 400, sizePt: 13, letterSpacing: 0.3, x: 7, y: 33 }),
        makeText({ name: 'Valid thru', text: 'VALID\nTHRU', font: 'roboto', sizePt: 3.5, lineHeight: 1.1, x: 32, y: 40.2 }),
        makeText({ name: 'Expiry', format: 'expiry', text: '12/30', font: 'mono', sizePt: 8, x: 38, y: 40 }),
        makeText({ name: 'Card holder', format: 'upper', text: 'JANE A. DOE', font: 'roboto', weight: 400, sizePt: 8.5, letterSpacing: 0.4, x: 7, y: 46 }),
        makeEllipse({ name: 'Network circle 1', op: 'score', x: 62, y: 40, w: 11, h: 11 }),
        makeEllipse({ name: 'Network circle 2', op: 'score', x: 68.5, y: 40, w: 11, h: 11 }),
      ];
      p.sides.back = [
        makeRect({ name: 'Signature panel', op: 'score', x: 7, y: 10, w: 50, h: 9, radius: 0.8 }),
        makeText({ name: 'CVV', format: 'digits', text: '123', font: 'mono', sizePt: 9, x: 61, y: 12 }),
        makeText({ name: 'Fine print', text: 'This card is property of Metal Bank. If found, please return.\nCustomer service: +1 800 000 0000', font: 'roboto', sizePt: 4.5, lineHeight: 1.4, x: 7, y: 26 }),
        makeText({ name: 'Bank name', text: 'METAL BANK', font: 'montserrat', weight: 700, sizePt: 8, letterSpacing: 0.5, x: 7, y: 44 }),
      ];
    },
  },
  centurion: {
    group: 'Credit cards',
    label: 'Black charge card (centurion style)',
    desc: 'Amex-inspired: double border, centred issuer name, chip, oval emblem, “Member since” ribbon. Add your own emblem image in the oval.',
    build(p) {
      const c = p.card;
      c.material = 'black';
      const cx = c.w / 2;
      p.sides.front = [
        ...doubleBorder(c),
        ctext({ name: 'Issuer name', text: 'YOUR BANK', font: 'montserrat', weight: 700, sizePt: 9.5, letterSpacing: 0.5, x: cx, y: 5 }),
        makeChipArt({ x: 10.5, y: 16 }),
        makeEllipse({ name: 'Emblem oval (outer)', op: 'score', x: cx - 9.6, y: 13, w: 19.2, h: 24 }),
        makeEllipse({ name: 'Emblem oval (inner)', op: 'score', x: cx - 8.7, y: 13.9, w: 17.4, h: 22.2 }),
        ctext({ name: 'Emblem hint', op: 'none', text: 'Add your\nemblem\n(Image or\nSVG logo)', font: 'roboto', sizePt: 4, lineHeight: 1.3, x: cx, y: 19.2 }),
        ribbon('Member since ribbon', 59.3, 29.2, 17.4, 3.4),
        ctext({ name: 'Member since label', text: 'MEMBER SINCE', font: 'montserrat', weight: 700, sizePt: 3.6, letterSpacing: 0.25, x: 68, y: 29.9 }),
        ctext({ name: 'Member since year', format: 'digits', text: '24', font: 'roboto', sizePt: 8, x: 68, y: 33.4 }),
        makeText({ name: 'Card number', format: 'cardnumber', text: '3700 000000 00000', font: 'mono', sizePt: 9.5, letterSpacing: 0.25, x: 9.5, y: 38.5 }),
        makeText({ name: 'Card holder', format: 'upper', text: 'CARD HOLDER', font: 'roboto', sizePt: 8, letterSpacing: 0.3, x: 9.5, y: 44.6 }),
        makeText({ name: 'Fine print', text: '© YOUR BANK', font: 'roboto', weight: 700, sizePt: 3, x: 66, y: 48.2 }),
      ];
      p.sides.back = [
        ...doubleBorder(c),
        makeRect({ name: 'Signature panel', op: 'score', x: 7, y: 9, w: 46, h: 8, radius: 0.6 }),
        makeText({ name: 'Security code', format: 'digits', text: '1234', font: 'mono', sizePt: 8.5, x: 56, y: 10.6 }),
        makeText({
          name: 'Fine print',
          text: 'This card remains the property of Your Bank and must be returned on request.\nIf found, please call +1 800 000 0000 or return to any branch.',
          font: 'roboto',
          sizePt: 3.6,
          lineHeight: 1.5,
          x: 7,
          y: 22,
        }),
        ctext({ name: 'Issuer name', text: 'YOUR BANK', font: 'montserrat', weight: 700, sizePt: 7, letterSpacing: 0.5, x: cx, y: 42 }),
      ];
    },
  },
  minimal: {
    group: 'Credit cards',
    label: 'Minimal brushed steel',
    desc: 'Clean front with chip and contactless symbol; number, expiry and CVV on the back.',
    build(p) {
      p.card.material = 'silver';
      p.sides.front = [
        makeText({ name: 'Bank name', text: 'NORTH', font: 'orbitron', weight: 700, sizePt: 9, letterSpacing: 1.2, x: 7, y: 6 }),
        makeContactless({ x: 74, y: 5.2 }),
        makeChip({ x: 7.5, y: 19 }),
        makeText({ name: 'Card holder', format: 'upper', text: 'JANE A. DOE', font: 'montserrat', sizePt: 7, letterSpacing: 0.6, x: 7, y: 45 }),
        makeEllipse({ name: 'Network circle 1', op: 'engrave', x: 66.5, y: 42, w: 8, h: 8 }),
        makeEllipse({ name: 'Network circle 2', op: 'score', x: 71.5, y: 42, w: 8, h: 8 }),
      ];
      p.sides.back = [
        makeText({ name: 'Card number', format: 'cardnumber', text: '4000 1234 5678 9010', font: 'mono', sizePt: 10, letterSpacing: 0.3, x: 7, y: 9 }),
        makeText({ name: 'Expiry label', text: 'EXP', font: 'montserrat', weight: 700, sizePt: 4, x: 7, y: 17.5 }),
        makeText({ name: 'Expiry', format: 'expiry', text: '12/30', font: 'mono', sizePt: 8, x: 7, y: 20.5 }),
        makeText({ name: 'CVV label', text: 'CVV', font: 'montserrat', weight: 700, sizePt: 4, x: 24, y: 17.5 }),
        makeText({ name: 'CVV', format: 'digits', text: '123', font: 'mono', sizePt: 8, x: 24, y: 20.5 }),
        makeText({ name: 'Fine print', text: 'Issued by North Bank. Customer service +1 800 000 0000', font: 'roboto', sizePt: 3.8, x: 7, y: 44 }),
        makeText({ name: 'Bank name', text: 'NORTH', font: 'orbitron', weight: 700, sizePt: 7, letterSpacing: 1, x: 66, y: 43.5 }),
      ];
    },
  },
  gold: {
    group: 'Credit cards',
    label: 'Gold premium',
    desc: 'Serif bank name, tier label, chip art, contactless, single fine border.',
    build(p) {
      const c = p.card;
      c.material = 'gold';
      p.sides.front = [
        makeRect({ name: 'Border', op: 'score', x: 2.2, y: 2.2, w: c.w - 4.4, h: c.h - 4.4, radius: 1.6 }),
        makeText({ name: 'Bank name', text: 'Crown & Co.', font: 'playfair', weight: 700, sizePt: 11, x: 7, y: 5.5 }),
        makeText({ name: 'Tier', text: 'PREMIER', font: 'montserrat', weight: 700, sizePt: 5, letterSpacing: 1.2, x: 61, y: 7.6 }),
        makeChipArt({ x: 8, y: 17.5 }),
        makeContactless({ x: 22.5, y: 18.9 }),
        makeText({ name: 'Card number', format: 'cardnumber', text: '5500 0000 0000 0004', font: 'orbitron', sizePt: 10.5, letterSpacing: 0.4, x: 7, y: 31 }),
        makeText({ name: 'Good thru label', text: 'GOOD\nTHRU', font: 'roboto', weight: 700, sizePt: 3.2, lineHeight: 1.1, x: 33, y: 38.6 }),
        makeText({ name: 'Expiry', format: 'expiry', text: '12/30', font: 'mono', sizePt: 7.5, x: 39, y: 38.4 }),
        makeText({ name: 'Card holder', format: 'upper', text: 'JANE A. DOE', font: 'roboto', sizePt: 8, letterSpacing: 0.5, x: 7, y: 44.5 }),
        makeEllipse({ name: 'Network circle 1', op: 'score', x: 64, y: 40, w: 10, h: 10 }),
        makeEllipse({ name: 'Network circle 2', op: 'score', x: 70, y: 40, w: 10, h: 10 }),
      ];
      p.sides.back = [
        makeRect({ name: 'Border', op: 'score', x: 2.2, y: 2.2, w: c.w - 4.4, h: c.h - 4.4, radius: 1.6 }),
        makeRect({ name: 'Signature panel', op: 'score', x: 7, y: 10, w: 48, h: 8, radius: 0.6 }),
        makeText({ name: 'CVV', format: 'digits', text: '123', font: 'mono', sizePt: 8.5, x: 59, y: 11.6 }),
        makeText({ name: 'Fine print', text: 'Crown & Co. Premier card. If found, please call +1 800 000 0000.', font: 'roboto', sizePt: 3.8, x: 7, y: 25 }),
        ctext({ name: 'Bank name', text: 'Crown & Co.', font: 'playfair', weight: 700, sizePt: 9, x: c.w / 2, y: 40 }),
      ];
    },
  },

  // ----- business cards -----
  business: {
    group: 'Business cards',
    label: 'Classic business card',
    desc: 'Name, title, contact details and a QR code.',
    build(p) {
      p.card.material = 'silver';
      p.sides.front = [
        makeText({ name: 'Name', text: 'Alex Morgan', font: 'playfair', weight: 700, sizePt: 15, x: 7, y: 9 }),
        makeText({ name: 'Title', text: 'FOUNDER & CEO', font: 'montserrat', sizePt: 6, letterSpacing: 0.8, x: 7.3, y: 18 }),
        makeRect({ name: 'Divider', op: 'engrave', x: 7.3, y: 23, w: 30, h: 0.35 }),
        makeText({
          name: 'Contact',
          text: '+1 555 010 2030\nalex@company.com\nwww.company.com',
          font: 'montserrat',
          sizePt: 6.5,
          lineHeight: 1.55,
          x: 7.3,
          y: 31,
        }),
        makeQr({ name: 'QR code', data: 'https://www.company.com', x: 60, y: 24, w: 19, h: 19 }),
        ctext({ name: 'QR caption', text: 'SCAN ME', font: 'montserrat', weight: 700, sizePt: 4.5, letterSpacing: 0.6, x: 69.5, y: 45 }),
      ];
      p.sides.back = [
        ctext({ name: 'Company', text: 'COMPANY', font: 'montserrat', weight: 700, sizePt: 18, letterSpacing: 2, x: p.card.w / 2, y: 21 }),
      ];
    },
  },
  executive: {
    group: 'Business cards',
    label: 'Executive black (centred)',
    desc: 'Monogram, centred name and title, contact line; QR code on the back.',
    build(p) {
      const c = p.card;
      c.material = 'black';
      const cx = c.w / 2;
      p.sides.front = [
        makeEllipse({ name: 'Monogram circle', op: 'score', x: cx - 6.5, y: 6, w: 13, h: 13 }),
        ctext({ name: 'Monogram', format: 'upper', text: 'AM', font: 'playfair', weight: 700, sizePt: 13, x: cx, y: 8.2 }),
        ctext({ name: 'Name', text: 'Alex Morgan', font: 'playfair', weight: 700, sizePt: 14, x: cx, y: 22.5 }),
        ctext({ name: 'Title', format: 'upper', text: 'MANAGING DIRECTOR', font: 'montserrat', sizePt: 5.5, letterSpacing: 1, x: cx, y: 31 }),
        makeRect({ name: 'Divider', op: 'engrave', x: cx - 8, y: 36, w: 16, h: 0.3 }),
        ctext({ name: 'Contact', text: '+1 555 010 2030  ·  alex@company.com\nwww.company.com', font: 'montserrat', sizePt: 5.5, lineHeight: 1.7, x: cx, y: 39.5 }),
      ];
      p.sides.back = [
        makeQr({ name: 'QR code', data: 'https://www.company.com', x: cx - 11, y: 9, w: 22, h: 22 }),
        ctext({ name: 'QR caption', format: 'upper', text: 'CONNECT WITH ME', font: 'montserrat', weight: 700, sizePt: 5, letterSpacing: 1, x: cx, y: 35 }),
        ctext({ name: 'Company', format: 'upper', text: 'COMPANY', font: 'montserrat', sizePt: 6, letterSpacing: 2, x: cx, y: 43 }),
      ];
    },
  },
  modern: {
    group: 'Business cards',
    label: 'Modern split + key-ring hole',
    desc: 'Name on the left, contact on the right, divider line and a cut-out key-ring hole.',
    build(p) {
      const c = p.card;
      c.material = 'blue';
      p.sides.front = [
        makeText({ name: 'Name', text: 'ALEX\nMORGAN', font: 'montserrat', weight: 700, sizePt: 12, lineHeight: 1.1, letterSpacing: 0.4, x: 7, y: 12 }),
        makeText({ name: 'Title', text: 'Product Designer', font: 'montserrat', sizePt: 6, x: 7, y: 26 }),
        makeRect({ name: 'Divider', op: 'engrave', x: 44, y: 10, w: 0.35, h: 34 }),
        makeText({
          name: 'Contact',
          text: 'T  +1 555 010 2030\nE  alex@company.com\nW  company.com\nA  12 Main St, City',
          font: 'montserrat',
          sizePt: 5.8,
          lineHeight: 1.85,
          x: 48,
          y: 13,
        }),
        makeEllipse({ name: 'Key-ring hole', op: 'cut', x: c.w - 8.5, y: c.h - 8.5, w: 4, h: 4 }),
      ];
      p.sides.back = [
        ctext({ name: 'Company', format: 'upper', text: 'COMPANY', font: 'orbitron', weight: 700, sizePt: 16, letterSpacing: 1.5, x: c.w / 2, y: 18 }),
        ctext({ name: 'Tagline', text: 'Design · Build · Ship', font: 'montserrat', sizePt: 6, letterSpacing: 0.6, x: c.w / 2, y: 30 }),
      ];
    },
  },
  signature: {
    group: 'Business cards',
    label: 'Signature script + QR',
    desc: 'Elegant script name on the front, large QR code on the back.',
    build(p) {
      const c = p.card;
      c.material = 'rose';
      const cx = c.w / 2;
      p.sides.front = [
        ...doubleBorder(c, 2.5, 0.6),
        ctext({ name: 'Name', text: 'Alex Morgan', font: 'greatvibes', sizePt: 24, x: cx, y: 12 }),
        ctext({ name: 'Title', format: 'upper', text: 'PHOTOGRAPHER', font: 'montserrat', sizePt: 5.5, letterSpacing: 1.5, x: cx, y: 29 }),
        ctext({ name: 'Contact', text: '+1 555 010 2030  ·  alex@studio.com', font: 'montserrat', sizePt: 5.5, x: cx, y: 40 }),
      ];
      p.sides.back = [
        ...doubleBorder(c, 2.5, 0.6),
        makeQr({ name: 'QR code', data: 'https://www.studio.com', x: cx - 13, y: 7, w: 26, h: 26 }),
        ctext({ name: 'QR caption', text: 'www.studio.com', font: 'montserrat', sizePt: 6, letterSpacing: 0.4, x: cx, y: 38 }),
      ];
    },
  },

  monogram: {
    group: 'Business cards',
    label: 'Minimal monogram',
    desc: 'Big monogram in a ring on the front; name, title and contact on the back.',
    build(p) {
      const c = p.card;
      c.material = 'black';
      const cx = c.w / 2;
      p.sides.front = [
        makeEllipse({ name: 'Monogram ring', op: 'score', x: cx - 13, y: c.h / 2 - 13, w: 26, h: 26 }),
        ctext({ name: 'Monogram', format: 'upper', text: 'AM', font: 'playfair', weight: 700, sizePt: 26, x: cx, y: c.h / 2 - 6.6 }),
      ];
      p.sides.back = [
        ctext({ name: 'Name', text: 'Alex Morgan', font: 'playfair', weight: 700, sizePt: 13, x: cx, y: 10 }),
        ctext({ name: 'Title', format: 'upper', text: 'ARCHITECT', font: 'montserrat', sizePt: 5.5, letterSpacing: 1.6, x: cx, y: 18.5 }),
        makeRect({ name: 'Divider', op: 'engrave', x: cx - 6, y: 24, w: 12, h: 0.3 }),
        ctext({ name: 'Contact', text: '+1 555 010 2030\nalex@studio-am.com\nstudio-am.com', font: 'montserrat', sizePt: 6, lineHeight: 1.7, x: cx, y: 28 }),
      ];
    },
  },
  corporate: {
    group: 'Business cards',
    label: 'Corporate / law firm',
    desc: 'Serif firm name, accent bar, name and credentials, office details.',
    build(p) {
      const c = p.card;
      c.material = 'silver';
      p.sides.front = [
        makeRect({ name: 'Accent bar', op: 'engrave', x: 6, y: 8, w: 1.2, h: 38 }),
        makeText({ name: 'Firm', format: 'upper', text: 'MORGAN & REED', font: 'playfair', weight: 700, sizePt: 10, letterSpacing: 0.6, x: 10, y: 8 }),
        makeText({ name: 'Firm subtitle', text: 'Attorneys at Law', font: 'playfair', sizePt: 6.5, x: 10, y: 14.5 }),
        makeText({ name: 'Name', text: 'Alexandra Morgan, Esq.', font: 'montserrat', weight: 700, sizePt: 7.5, x: 10, y: 27 }),
        makeText({ name: 'Title', text: 'Senior Partner', font: 'montserrat', sizePt: 6, x: 10, y: 31.5 }),
        makeText({
          name: 'Contact',
          text: 'T  +1 555 010 2030\nE  amorgan@morganreed.law\nA  100 Main Street, Suite 400',
          font: 'montserrat',
          sizePt: 5.2,
          lineHeight: 1.6,
          x: 10,
          y: 37.5,
        }),
      ];
      p.sides.back = [ctext({ name: 'Firm', format: 'upper', text: 'MORGAN & REED', font: 'playfair', weight: 700, sizePt: 14, letterSpacing: 1.2, x: c.w / 2, y: 21 })];
    },
  },
  realestate: {
    group: 'Business cards',
    label: 'Real estate agent',
    desc: 'House icon, agent name, phone in large type and a QR code to your listings.',
    build(p) {
      const c = p.card;
      c.material = 'gold';
      const house = [
        { type: 'M', x: 0, y: 6 },
        { type: 'L', x: 6, y: 0 },
        { type: 'L', x: 12, y: 6 },
        { type: 'L', x: 10.4, y: 6 },
        { type: 'L', x: 10.4, y: 12 },
        { type: 'L', x: 7.3, y: 12 },
        { type: 'L', x: 7.3, y: 8 },
        { type: 'L', x: 4.7, y: 8 },
        { type: 'L', x: 4.7, y: 12 },
        { type: 'L', x: 1.6, y: 12 },
        { type: 'L', x: 1.6, y: 6 },
        { type: 'Z' },
      ];
      p.sides.front = [
        shape('House icon', 'engrave', 7, 7, 10, 10, house),
        makeText({ name: 'Agency', format: 'upper', text: 'GOLDEN KEY REALTY', font: 'montserrat', weight: 700, sizePt: 6.5, letterSpacing: 0.8, x: 20, y: 10 }),
        makeText({ name: 'Name', text: 'Alex Morgan', font: 'playfair', weight: 700, sizePt: 13, x: 7, y: 22 }),
        makeText({ name: 'Title', text: 'Licensed Realtor®', font: 'montserrat', sizePt: 5.5, x: 7, y: 30.5 }),
        makeText({ name: 'Phone', text: '(555) 010-2030', font: 'montserrat', weight: 700, sizePt: 9, x: 7, y: 38 }),
        makeText({ name: 'Email', text: 'alex@goldenkey.com', font: 'montserrat', sizePt: 5.5, x: 7, y: 44.5 }),
        makeQr({ name: 'Listings QR', data: 'https://goldenkey.com/alex', x: 61, y: 24, w: 18, h: 18 }),
        ctext({ name: 'QR caption', format: 'upper', text: 'MY LISTINGS', font: 'montserrat', weight: 700, sizePt: 4, letterSpacing: 0.5, x: 70, y: 44 }),
      ];
      p.sides.back = [
        shape('House icon', 'engrave', c.w / 2 - 8, 10, 16, 16, house),
        ctext({ name: 'Agency', format: 'upper', text: 'GOLDEN KEY REALTY', font: 'montserrat', weight: 700, sizePt: 9, letterSpacing: 1.2, x: c.w / 2, y: 32 }),
      ];
    },
  },
  vertical: {
    group: 'Business cards',
    label: 'Vertical / portrait',
    desc: 'Portrait card: name at the top, contact in the middle, QR code at the bottom.',
    build(p) {
      const c = p.card;
      Object.assign(c, { preset: 'custom', w: 53.98, h: 85.6, radius: 3.18, kind: 'card', material: 'blackacrylic' });
      const cx = c.w / 2;
      p.sides.front = [
        ctext({ name: 'Name', text: 'Alex\nMorgan', font: 'montserrat', weight: 700, sizePt: 15, lineHeight: 1.05, letterSpacing: 0.3, x: cx, y: 8 }),
        ctext({ name: 'Title', format: 'upper', text: 'BRAND DESIGNER', font: 'montserrat', sizePt: 5.5, letterSpacing: 1.4, x: cx, y: 25 }),
        makeRect({ name: 'Divider', op: 'engrave', x: cx - 5, y: 30.5, w: 10, h: 0.3 }),
        ctext({ name: 'Contact', text: '+1 555 010 2030\nalex@morgan.design\nmorgan.design', font: 'montserrat', sizePt: 5.8, lineHeight: 1.7, x: cx, y: 34 }),
        makeQr({ name: 'QR code', data: 'https://morgan.design', x: cx - 10, y: 55, w: 20, h: 20 }),
      ];
      p.sides.back = [ctext({ name: 'Initials', format: 'upper', text: 'AM', font: 'orbitron', weight: 700, sizePt: 34, x: cx, y: 30 })];
    },
  },
  tech: {
    group: 'Business cards',
    label: 'Tech startup',
    desc: 'Hexagon logo mark, futuristic type, GitHub/LinkedIn line and a QR code.',
    build(p) {
      const c = p.card;
      c.material = 'black';
      p.sides.front = [
        makePolygon({ name: 'Logo hexagon', op: 'score', x: 7, y: 7, w: 11, h: 11, sides: 6 }),
        makePolygon({ name: 'Logo core', op: 'engrave', x: 9.75, y: 9.75, w: 5.5, h: 5.5, sides: 6 }),
        makeText({ name: 'Company', format: 'upper', text: 'NEXORA', font: 'orbitron', weight: 700, sizePt: 10, letterSpacing: 1.2, x: 21, y: 9.3 }),
        makeText({ name: 'Name', text: 'Alex Morgan', font: 'montserrat', weight: 700, sizePt: 10, x: 7, y: 26 }),
        makeText({ name: 'Title', text: 'Co-founder & CTO', font: 'montserrat', sizePt: 6, x: 7, y: 32 }),
        makeText({ name: 'Contact', text: 'alex@nexora.io  ·  +1 555 010 2030\ngithub.com/alexm  ·  in/alexmorgan', font: 'mono', sizePt: 4.8, lineHeight: 1.6, x: 7, y: 41 }),
        makeQr({ name: 'QR code', data: 'https://nexora.io', x: 63, y: 7, w: 15, h: 15 }),
      ];
      p.sides.back = [
        makePolygon({ name: 'Logo hexagon', op: 'score', x: c.w / 2 - 9, y: 11, w: 18, h: 18, sides: 6 }),
        makePolygon({ name: 'Logo core', op: 'engrave', x: c.w / 2 - 4.5, y: 15.5, w: 9, h: 9, sides: 6 }),
        ctext({ name: 'Company', format: 'upper', text: 'NEXORA', font: 'orbitron', weight: 700, sizePt: 11, letterSpacing: 2, x: c.w / 2, y: 34 }),
      ];
    },
  },
  badge: {
    group: 'Business cards',
    label: 'Badge logo (barber / tattoo / café)',
    desc: 'Circular badge with curved shop name, centre star, and details beside it.',
    build(p) {
      const c = p.card;
      c.material = 'rose';
      const bx = 23;
      const by = c.h / 2;
      p.sides.front = [
        makeEllipse({ name: 'Badge outer', op: 'score', x: bx - 17, y: by - 17, w: 34, h: 34 }),
        makeEllipse({ name: 'Badge inner', op: 'score', x: bx - 9.5, y: by - 9.5, w: 19, h: 19 }),
        ctext({ name: 'Shop name (curved)', format: 'upper', text: 'IRON & OAK', font: 'montserrat', weight: 700, sizePt: 6.5, letterSpacing: 0.6, arc: 13, x: bx, y: by - 16 }),
        ctext({ name: 'Since (curved)', format: 'upper', text: 'EST 2024', font: 'montserrat', sizePt: 5, letterSpacing: 0.8, arc: -13, x: bx, y: by + 10.5 }),
        makeStar({ name: 'Badge star', op: 'engrave', x: bx - 5, y: by - 5, w: 10, h: 10 }),
        makeText({ name: 'Shop', format: 'upper', text: 'IRON & OAK', font: 'montserrat', weight: 700, sizePt: 10, letterSpacing: 0.8, x: 46, y: 12 }),
        makeText({ name: 'Trade', text: 'Barber Shop', font: 'greatvibes', sizePt: 13, x: 46, y: 18.5 }),
        makeText({ name: 'Contact', text: '+1 555 010 2030\n12 Main St, City\nironandoak.com', font: 'montserrat', sizePt: 5.2, lineHeight: 1.6, x: 46, y: 33 }),
      ];
      p.sides.back = [ctext({ name: 'Slogan', text: 'Look sharp.', font: 'greatvibes', sizePt: 26, x: c.w / 2, y: 17 })];
    },
  },

  // ----- other laser projects -----
  workspace: {
    group: 'Other projects',
    label: 'Free layout on a 300 × 200 mm bed',
    desc: 'Any project: signs, tags, ornaments, nesting several parts – like an empty LightBurn workspace.',
    build(p) {
      applyPreset(p.card, 'bed300');
      p.card.material = 'wood';
    },
  },
  coaster: {
    group: 'Other projects',
    label: 'Round coaster with curved text',
    desc: 'Ø 100 mm, text curved along the top and bottom, engraved ring and centre star.',
    build(p) {
      applyPreset(p.card, 'coaster');
      p.card.material = 'wood';
      p.sides.front = [
        makeEllipse({ name: 'Ring', op: 'score', x: 6, y: 6, w: 88, h: 88 }),
        ctext({ name: 'Top text', text: 'HOME SWEET HOME', font: 'montserrat', weight: 700, sizePt: 13, letterSpacing: 0.8, arc: 36, x: 50, y: 12 }),
        ctext({ name: 'Bottom text', text: 'EST. 2024', font: 'montserrat', sizePt: 11, letterSpacing: 1, arc: -36, x: 50, y: 74 }),
        makeStar({ name: 'Centre star', op: 'engrave', x: 38, y: 37, w: 24, h: 24 }),
      ];
    },
  },
  keychain: {
    group: 'Other projects',
    label: 'Key-chain name tag',
    desc: '60 × 25 mm tag with a cut-out hole and a big engraved name.',
    build(p) {
      applyPreset(p.card, 'tag');
      p.card.material = 'wood';
      p.sides.front = [
        makeEllipse({ name: 'Key-ring hole', op: 'cut', x: 4, y: 10, w: 5, h: 5 }),
        ctext({ name: 'Name', text: 'Alex', font: 'greatvibes', sizePt: 30, x: 35, y: 1.5 }),
      ];
    },
  },
  sign: {
    group: 'Other projects',
    label: 'Wooden sign',
    desc: '200 × 100 mm sign with a double border and large title.',
    build(p) {
      applyPreset(p.card, 'sign');
      p.card.material = 'wood';
      p.sides.front = [
        ...doubleBorder(p.card, 5, 1.5),
        ctext({ name: 'Title', text: 'The Workshop', font: 'playfair', weight: 700, sizePt: 60, x: 100, y: 22 }),
        ctext({ name: 'Subtitle', format: 'upper', text: 'MADE WITH LOVE', font: 'montserrat', sizePt: 16, letterSpacing: 3, x: 100, y: 66 }),
      ];
    },
  },
};

// ---------- quick-fill formatting ----------

// Text formats used by the Quick Fill form so people can type naturally.
export const FORMATS = {
  none: { label: 'As typed', apply: (v) => v },
  upper: { label: 'UPPERCASE', apply: (v) => v.toUpperCase() },
  cardnumber: {
    label: 'Card number (groups of 4)',
    apply: (v) => {
      const d = v.replace(/\D/g, '').slice(0, 19);
      // 15-digit Amex style is grouped 4-6-5
      if (d.length === 15) return [d.slice(0, 4), d.slice(4, 10), d.slice(10)].join(' ');
      return d.replace(/(.{4})/g, '$1 ').trim();
    },
  },
  expiry: {
    label: 'Expiry MM/YY',
    apply: (v) => {
      const d = v.replace(/\D/g, '').slice(0, 4);
      return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
    },
  },
  digits: { label: 'Digits only', apply: (v) => v.replace(/\D/g, '') },
};

export function formatText(format, value) {
  const f = FORMATS[format] || FORMATS.none;
  return f.apply(String(value ?? ''));
}

// ---------- geometry of elements ----------

// Returns the element's local → card matrix. Local space is the element's own
// box from (0, 0) to (w, h); rotation is around the box centre.
export function elementMatrix(el, w, h) {
  const m = compose(translate(el.x, el.y), rotate(el.rotation || 0, w / 2, h / 2));
  if (!el.flipX && !el.flipY) return m;
  const fx = el.flipX ? -1 : 1;
  const fy = el.flipY ? -1 : 1;
  return compose(m, [fx, 0, 0, fy, el.flipX ? w : 0, el.flipY ? h : 0]);
}

// Regular polygon / star inside the box (0,0)-(w,h), first point at the top.
export function polygonPath(w, h, sides, star, inner) {
  const n = Math.max(3, Math.round(sides || 3));
  const pts = star ? n * 2 : n;
  const cmds = [];
  for (let i = 0; i < pts; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / pts;
    const k = star && i % 2 ? Math.max(0.05, Math.min(0.95, inner || 0.5)) : 1;
    cmds.push({ type: i ? 'L' : 'M', x: w / 2 + (w / 2) * k * Math.cos(a), y: h / 2 + (h / 2) * k * Math.sin(a) });
  }
  cmds.push({ type: 'Z' });
  return cmds;
}

// Lays out multi-line text with an opentype.js font. Returns local-space path
// commands and the size of the text box.
export function layoutText(el, font) {
  const sizeMm = (el.sizePt || 10) * PT_TO_MM;
  const s = sizeMm / font.unitsPerEm;
  const lines = String(el.text ?? '').split('\n');
  const lineH = sizeMm * (el.lineHeight || 1.2);
  const ascent = font.ascender * s;
  const spacing = el.letterSpacing || 0;

  const laid = lines.map((line) => {
    // Map characters one by one: full OpenType shaping is not needed for card
    // text and some fonts' substitution tables are unsupported by opentype.js.
    const glyphs = Array.from(line, (ch) => font.charToGlyph(ch));
    const items = [];
    let x = 0;
    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i];
      items.push({ g, x });
      x += (g.advanceWidth || 0) * s;
      if (i < glyphs.length - 1) {
        x += font.getKerningValue(g, glyphs[i + 1]) * s + spacing;
      }
    }
    return { items, width: x };
  });
  const w = Math.max(0.5, ...laid.map((l) => l.width));
  const h = lines.length * lineH;
  const descent = -font.descender * s;
  const pad = (lineH - (ascent + descent)) / 2; // centre glyphs vertically in each line

  const cmds = [];
  const R = Number(el.arc) || 0; // bend radius in mm: + arches up, − curves down
  const b0 = pad + ascent;
  laid.forEach((l, li) => {
    let ox = 0;
    if (el.align === 'center') ox = (w - l.width) / 2;
    else if (el.align === 'right') ox = w - l.width;
    const baseline = li * lineH + pad + ascent;
    for (const { g, x } of l.items) {
      if (!R) {
        cmds.push(...fromOpentype(g.getPath(ox + x, baseline, sizeMm).commands));
        continue;
      }
      // Curved text: place each glyph on a circle, rotated to follow it.
      const adv = (g.advanceWidth || 0) * s;
      const gc = ox + x + adv / 2;
      const glyph = fromOpentype(g.getPath(-adv / 2, 0, sizeMm).commands);
      const r = Math.abs(R) - (R > 0 ? 1 : -1) * (baseline - b0);
      const a = (gc - w / 2) / Math.max(1, r);
      const cy = R > 0 ? b0 + Math.abs(R) : b0 - Math.abs(R);
      const px = w / 2 + r * Math.sin(a);
      const py = R > 0 ? cy - r * Math.cos(a) : cy + r * Math.cos(a);
      const deg = ((R > 0 ? a : -a) * 180) / Math.PI;
      cmds.push(...transformPath(glyph, compose(translate(px, py), rotate(deg))));
    }
  });
  if (!R || !cmds.length) return { cmds, w, h };
  // the curved text's box is its real extent
  const b = pathBounds(cmds);
  return { cmds: transformPath(cmds, translate(-b.x, -b.y)), w: Math.max(0.5, b.w), h: Math.max(0.5, b.h) };
}

// Builds QR modules as merged horizontal runs.
export function qrPath(el, qrcode) {
  const qr = qrcode(0, el.ecl || 'M');
  qr.addData(String(el.data || ' '));
  qr.make();
  const n = qr.getModuleCount();
  const m = el.w / n;
  const cmds = [];
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!qr.isDark(r, c)) {
        c++;
        continue;
      }
      const start = c;
      while (c < n && qr.isDark(r, c)) c++;
      cmds.push(...rectPath(start * m, r * m, (c - start) * m, m));
    }
  }
  return cmds;
}

// Converts an element to { cmds (card mm), w, h, matrix, raster? }.
// ctx: { getFont(key, weight) -> opentype Font | null, qrcode }
export function elementGeometry(el, ctx) {
  let local = [];
  let w = el.w || 0;
  let h = el.h || 0;
  let raster = null;
  let fillRule = 'nonzero';

  switch (el.type) {
    case 'text': {
      const font = ctx.getFont(el.font, el.weight);
      if (font) {
        const t = layoutText(el, font);
        local = t.cmds;
        w = t.w;
        h = t.h;
      } else {
        w = 10;
        h = (el.sizePt || 10) * PT_TO_MM;
      }
      break;
    }
    case 'rect':
      local = rectPath(0, 0, w, h, el.radius || 0);
      break;
    case 'ellipse':
      local = ellipsePath(w / 2, h / 2, w / 2, h / 2);
      break;
    case 'polygon':
      local = polygonPath(w, h, el.sides, el.star, el.inner);
      break;
    case 'qr':
      h = w;
      local = ctx.qrcode ? qrPath({ ...el, w }, ctx.qrcode) : [];
      break;
    case 'vector': {
      const b = el.bounds || { x: 0, y: 0, w: 1, h: 1 };
      // a straight horizontal/vertical line has zero width or height
      const m = compose(scale(b.w > 1e-6 ? w / b.w : 1, b.h > 1e-6 ? h / b.h : 1), translate(-b.x, -b.y));
      local = transformPath(el.paths || [], m);
      fillRule = el.fillRule || 'nonzero';
      break;
    }
    case 'image':
      raster = { src: el.src, w, h };
      break;
    case 'erase':
      local = rectPath(0, 0, w, h, 0);
      break;
    default:
      break;
  }
  // anchor 'center': x is the horizontal centre, so edited text stays centred
  const left = el.anchor === 'center' ? el.x - w / 2 : el.x;
  const matrix = elementMatrix(left === el.x ? el : { ...el, x: left }, w, h);
  return { cmds: transformPath(local, matrix), w, h, matrix, raster, fillRule };
}
