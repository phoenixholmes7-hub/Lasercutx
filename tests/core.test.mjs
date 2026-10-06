import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as opentype from '../src/vendor/opentype.mjs';
import qrcode from '../src/vendor/qrcode.mjs';
import { parseSvgPath, flatten, pathBounds, toSvgD, rectPath } from '../src/js/geometry.js';
import { newProject, FONTS, formatText, elementGeometry, makeText, TEMPLATES } from '../src/js/model.js';
import { toSVG, toDXF, toRasterSVG, sheetLayout } from '../src/js/exporters.js';
import { traceMask, loopsToPath } from '../src/js/trace.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fontCache = {};
const ctx = {
  qrcode,
  getFont(key, weight) {
    const f = FONTS.find((x) => x.key === key) || FONTS[0];
    const file = f.files[weight] || f.files[400];
    if (!fontCache[file]) {
      const buf = fs.readFileSync(path.join(here, '../src/vendor/fonts', file));
      fontCache[file] = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    }
    return fontCache[file];
  },
};

test('svg path parser handles relative commands and arcs', () => {
  const cmds = parseSvgPath('m10 10 h20 v10 h-20 z M0 0 a5 5 0 1 0 10 0 a5 5 0 1 0 -10 0z');
  const b = pathBounds(cmds);
  assert.ok(Math.abs(b.x - 0) < 0.01 && Math.abs(b.w - 30) < 0.01, JSON.stringify(b));
  assert.ok(Math.abs(b.y + 5) < 0.05 && Math.abs(b.h - 25) < 0.05, JSON.stringify(b));
});

test('flatten closes rounded rectangles', () => {
  const polys = flatten(rectPath(0, 0, 85.6, 53.98, 3.18));
  assert.equal(polys.length, 1);
  assert.equal(polys[0].closed, true);
  assert.ok(polys[0].points.length > 8);
});

test('quick fill formats', () => {
  assert.equal(formatText('cardnumber', '4000123456789010'), '4000 1234 5678 9010');
  assert.equal(formatText('cardnumber', '3782 822463 10005'), '3782 822463 10005');
  assert.equal(formatText('expiry', '1230'), '12/30');
  assert.equal(formatText('upper', 'jane doe'), 'JANE DOE');
});

test('text layout produces geometry inside its box', () => {
  const el = makeText({ text: 'Hello\nWorld', x: 5, y: 5, sizePt: 12 });
  const g = elementGeometry(el, ctx);
  const b = pathBounds(g.cmds);
  assert.ok(g.cmds.length > 10);
  assert.ok(b.x >= 5 - 0.5 && b.y >= 5 - 0.5 && b.x + b.w <= 5 + g.w + 0.5 && b.y + b.h <= 5 + g.h + 0.5, JSON.stringify({ b, w: g.w, h: g.h }));
});

for (const tpl of Object.keys(TEMPLATES).filter((k) => k !== 'blank')) {
  test(`${tpl} template exports SVG and DXF`, () => {
    const p = newProject(tpl);
    for (const side of ['front', 'back']) {
      const svg = toSVG(p, side, ctx, { mirror: side === 'back' });
      assert.match(svg, /<svg[^>]+viewBox="0 0 85.6 53.98"/);
      assert.match(svg, /id="card-outline"/);
      assert.ok(!/NaN|undefined/.test(svg), 'svg contains NaN/undefined');
      const { dxf } = toDXF(p, side, ctx);
      assert.match(dxf, /AC1009/);
      assert.ok(dxf.includes('ENGRAVE') && dxf.includes('CUT'));
      assert.ok(!/NaN|undefined/.test(dxf), 'dxf contains NaN/undefined');
      assert.ok(!/NaN|undefined/.test(toRasterSVG(p, side, ctx)));
    }
  });
}

test('tracer finds outer outline and hole of a ring', () => {
  const W = 10;
  const H = 10;
  const mask = new Uint8Array(W * H);
  for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) mask[y * W + x] = 1;
  for (let y = 4; y < 6; y++) for (let x = 4; x < 6; x++) mask[y * W + x] = 0;
  const loops = traceMask(mask, W, H);
  assert.equal(loops.length, 2);
  assert.deepEqual(loops.map((l) => l.length).sort(), [4, 4]);
  const d = toSvgD(loopsToPath(loops, 0.1));
  assert.match(d, /^M/);
});

test('tracer smoothing straightens a diagonal staircase', () => {
  const N = 40;
  const mask = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x <= y; x++) mask[y * N + x] = 1; // triangle
  const raw = traceMask(mask, N, N)[0].length;
  const smooth = traceMask(mask, N, N, { smooth: 0.75 })[0].length;
  assert.ok(raw > 40, `raw ${raw}`);
  assert.ok(smooth <= 6, `smooth ${smooth}`);
});

test('template content stays on the card', () => {
  for (const key of Object.keys(TEMPLATES)) {
    const p = newProject(key);
    for (const side of ['front', 'back']) {
      for (const el of p.sides[side]) {
        const b = pathBounds(elementGeometry(el, ctx).cmds);
        if (!b.w) continue;
        assert.ok(b.x >= 0.5 && b.y >= 0.5 && b.x + b.w <= p.card.w - 0.5 && b.y + b.h <= p.card.h - 0.5, `${key}/${side}/${el.name} ${JSON.stringify(b)}`);
      }
    }
  }
});

test('centre-anchored text stays centred when edited', () => {
  const el = makeText({ anchor: 'center', x: 42.8, text: 'AB' });
  for (const text of ['AB', 'A MUCH LONGER NAME']) {
    el.text = text;
    const b = pathBounds(elementGeometry(el, ctx).cmds);
    assert.ok(Math.abs(b.x + b.w / 2 - 42.8) < 0.3, `${text}: ${b.x + b.w / 2}`);
  }
});

test('bulk sheet repeats the card in a grid', () => {
  const p = newProject('credit');
  const sheet = { count: 6, cols: 3, gap: 3 };
  const l = sheetLayout(p.card, sheet);
  assert.equal(l.rows, 2);
  assert.ok(Math.abs(l.w - (3 * 85.6 + 6)) < 1e-9 && Math.abs(l.h - (2 * 53.98 + 3)) < 1e-9);
  const svg = toSVG(p, 'front', ctx, { sheet });
  assert.equal((svg.match(/id="card-outline-c\d"/g) || []).length, 6);
  assert.match(svg, /viewBox="0 0 262.8 110.96"/);
  const single = toDXF(p, 'front', ctx).dxf.match(/POLYLINE/g).length;
  const bulk = toDXF(p, 'front', ctx, { sheet }).dxf;
  assert.equal(bulk.match(/POLYLINE/g).length, single * 6);
  assert.match(bulk, /\$EXTMAX\r\n10\r\n262.8\r\n20\r\n110.96/);
  assert.equal((toRasterSVG(p, 'front', ctx, { sheet, layers: ['cut'] }).match(/<path/g) || []).length, 6 + 0 * single);
});
