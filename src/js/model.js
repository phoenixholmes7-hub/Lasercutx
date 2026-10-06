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
} from './geometry.js';

export const PT_TO_MM = 25.4 / 72;

export const CARD_PRESETS = {
  iso: { label: 'Credit card – ISO ID-1 (85.60 × 53.98 mm)', w: 85.6, h: 53.98, radius: 3.18 },
  us: { label: 'US business card (88.9 × 50.8 mm)', w: 88.9, h: 50.8, radius: 3 },
  eu: { label: 'EU business card (85 × 55 mm)', w: 85, h: 55, radius: 3 },
  custom: { label: 'Custom size', w: 85.6, h: 53.98, radius: 3.18 },
};

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
    card: { preset: 'iso', ...pick(CARD_PRESETS.iso, ['w', 'h', 'radius']), material: 'silver', includeOutline: true },
    sides: { front: [], back: [] },
    customFonts: [],
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
  return compose(translate(el.x, el.y), rotate(el.rotation || 0, w / 2, h / 2));
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
  laid.forEach((l, li) => {
    let ox = 0;
    if (el.align === 'center') ox = (w - l.width) / 2;
    else if (el.align === 'right') ox = w - l.width;
    const baseline = li * lineH + pad + ascent;
    for (const { g, x } of l.items) {
      const p = g.getPath(ox + x, baseline, sizeMm);
      cmds.push(...fromOpentype(p.commands));
    }
  });
  return { cmds, w, h };
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
    case 'qr':
      h = w;
      local = ctx.qrcode ? qrPath({ ...el, w }, ctx.qrcode) : [];
      break;
    case 'vector': {
      const b = el.bounds || { x: 0, y: 0, w: 1, h: 1 };
      const m = compose(scale(w / (b.w || 1), h / (b.h || 1)), translate(-b.x, -b.y));
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
