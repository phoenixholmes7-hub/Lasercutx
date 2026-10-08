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
      assert.ok(svg.includes(`viewBox="0 0 ${p.card.w} ${p.card.h}"`), 'viewBox');
      if (p.card.includeOutline) assert.match(svg, /id="card-outline"/);
      assert.ok(!/NaN|undefined/.test(svg), 'svg contains NaN/undefined');
      const { dxf } = toDXF(p, side, ctx);
      assert.match(dxf, /AC1009/);
      assert.ok(dxf.includes('ENGRAVE') && dxf.includes('CUT'));
      if (p.sides[side].length || p.card.includeOutline) assert.match(dxf, /POLYLINE/);
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

test('hatch fills a square with a hole using the nonzero rule', async () => {
  const { hatch } = await import('../src/js/gcode.js');
  const outer = rectPath(0, 0, 10, 10);
  // hole drawn in the opposite direction
  const hole = [
    { type: 'M', x: 3, y: 3 },
    { type: 'L', x: 3, y: 7 },
    { type: 'L', x: 7, y: 7 },
    { type: 'L', x: 7, y: 3 },
    { type: 'Z' },
  ];
  const segs = hatch([...outer, ...hole], 1);
  assert.equal(new Set(segs.map((s) => s[1])).size, 10);
  const mid = segs.filter((s) => s[1] === 5.5);
  assert.equal(mid.length, 2, JSON.stringify(mid));
  const len = segs.reduce((a, [x0, , x1]) => a + Math.abs(x1 - x0), 0);
  assert.ok(Math.abs(len - (100 - 16)) < 1e-6, String(len));
});

test('G-code: units, inner cuts before outline, power scaling', async () => {
  const { toGcode } = await import('../src/js/gcode.js');
  const p = newProject('keychain');
  const { gcode, stats } = toGcode(p, 'front', ctx);
  assert.match(gcode, /^; LaserCutX/);
  assert.match(gcode, /\nG21\nG90\nM4 S0\n/);
  const hole = gcode.indexOf('Cut: Key-ring hole');
  const outline = gcode.indexOf('Cut: Card outline');
  assert.ok(hole > 0 && outline > hole, 'hole cut before outline');
  assert.ok(gcode.includes('S900 F300'), 'cut power 90% of S1000 at 300 mm/min');
  assert.ok(gcode.indexOf('Fill: Name') < hole, 'engrave before cut');
  assert.ok(stats.seconds > 0 && !/NaN/.test(gcode));
});

test('polygons, stars, flips and curved text', async () => {
  const { makePolygon, makeStar, elementMatrix } = await import('../src/js/model.js');
  const hex = elementGeometry(makePolygon({ x: 0, y: 0, w: 10, h: 10, sides: 6 }), ctx);
  assert.equal(hex.cmds.filter((c) => c.type === 'L').length, 5);
  const star = elementGeometry(makeStar({ x: 0, y: 0, w: 10, h: 10, sides: 5 }), ctx);
  assert.equal(star.cmds.filter((c) => c.type !== 'Z').length, 10);
  // flipX mirrors inside the same box
  const m = elementMatrix({ x: 5, y: 0, flipX: true }, 10, 4);
  const [x0] = [m[0] * 0 + m[4]];
  assert.equal(x0, 15);
  // curved text is taller than straight text of the same size
  const straight = elementGeometry(makeText({ text: 'HELLO WORLD', sizePt: 12 }), ctx);
  const curved = elementGeometry(makeText({ text: 'HELLO WORLD', sizePt: 12, arc: 15 }), ctx);
  assert.ok(curved.h > straight.h * 1.5, `${curved.h} vs ${straight.h}`);
  assert.ok(!curved.cmds.some((c) => Number.isNaN(c.x)));
});

test('machine profiles, presets and unit-correct G-code feeds', async () => {
  const { MACHINES, PRESETS, setMachine, applyMaterialPreset, toMmPerMin } = await import('../src/js/machines.js');
  const { laserDefaults } = await import('../src/js/model.js');
  const { toGcode } = await import('../src/js/gcode.js');
  assert.equal(MACHINES['thunder-nova-rf60'].speedUnit, 'mm/s');
  // switching GRBL (mm/min) -> Thunder (mm/s) keeps the same physical speed
  const L = laserDefaults();
  setMachine(L, 'grbl');
  L.engrave.speed = 6000; // mm/min
  setMachine(L, 'thunder-nova-rf60');
  assert.equal(L.engrave.speed, 100); // mm/s
  const p = applyMaterialPreset(L, 'thunder-nova-rf60', 'anodized-al');
  assert.equal(p.metalCard, true);
  assert.equal(L.engrave.speed, 400);
  assert.equal(L.cut.output, false);
  assert.equal(toMmPerMin(400, 'mm/s'), 24000);
  // every preset has sane values
  for (const [m, list] of Object.entries(PRESETS)) {
    for (const [k, pr] of Object.entries(list)) {
      for (const layer of ['engrave', 'score', 'image', 'cut']) {
        assert.ok(pr[layer] && pr[layer].power >= 0 && pr[layer].power <= 100, `${m}/${k}/${layer}`);
      }
    }
  }
  // G-code F words are mm/min even when settings are stored in mm/s
  const proj = newProject('keychain');
  proj.laser = L;
  proj.laser.cut = { output: true, speed: 20, power: 75, passes: 1 };
  const { gcode } = toGcode(proj, 'front', ctx);
  assert.ok(gcode.includes('F1200'), 'cut 20 mm/s -> F1200');
  assert.ok(gcode.includes('F24000'), 'fill 400 mm/s -> F24000');
});

test('Ruida encoding: swizzle, numbers, packets', async () => {
  const R = await import('../src/js/ruida.js');
  // the controller's ACK arrives as 0xC6 (as used by LibLaserCut/VisiCut)
  assert.equal(R.swizzleByte(R.ACK), 0xc6);
  for (let b = 0; b < 256; b++) assert.equal(R.unswizzleByte(R.swizzleByte(b)), b);
  assert.deepEqual(R.enc32(1000), [0, 0, 0, 7, 104]); // 1000 = 7*128 + 104
  assert.deepEqual(R.encPower(100), [0x7f, 0x7f]);
  assert.deepEqual(R.encCoord(85.6), R.enc32(85600));
  const data = R.swizzle(new Uint8Array(2500).fill(0x42));
  const pk = R.udpPackets(data);
  assert.equal(pk.length, 3);
  assert.equal(pk[0].length, R.UDP_CHUNK + 2);
  const sum = [...pk[2].subarray(2)].reduce((a, b) => a + b, 0);
  assert.equal((pk[2][0] << 8) | pk[2][1], sum & 0xffff);
});

test('Ruida job: layers, moves, frame at 0 % and file checksum', async () => {
  const R = await import('../src/js/ruida.js');
  const p = newProject('keychain');
  p.laser.machine.speedUnit = 'mm/s';
  p.laser.engrave = { output: true, speed: 300, power: 30, passes: 1, interval: 0.2 };
  p.laser.cut = { output: true, speed: 20, power: 75, passes: 1 };
  const job = R.buildRuidaJob(p, 'front', ctx, { homeCorner: 'top-right' });
  assert.deepEqual(job.parts.map((x) => x.name), ['Fill', 'Cut']);
  assert.ok(Math.abs(job.bounds.w - 60) < 1e-6 && Math.abs(job.bounds.h - 25) < 1e-6);
  const b = job.bytes;
  assert.deepEqual([...b.slice(0, 2)], [0xd8, 0x12]); // start from current position
  assert.equal(b[b.length - 1], 0xd7); // end of file
  // every data byte must be 7-bit except command bytes; the checksum covers all before it
  const sumAt = b.length - 8; // E5 05 + 5-byte sum + D7
  assert.deepEqual([...b.slice(sumAt, sumAt + 2)], [0xe5, 0x05]);
  const expected = [...b.slice(0, sumAt)].reduce((a, x) => a + x, 0) + 0xd7;
  assert.deepEqual([...b.slice(sumAt + 2, sumAt + 7)], R.enc32(expected));
  // speed 20 mm/s encoded as 20000 µm/s in the cut layer
  const hex = Buffer.from(b).toString('hex');
  assert.ok(hex.includes('c90401' + Buffer.from(R.enc32(20000)).toString('hex')), 'cut layer speed');
  // frame: one 0 % layer tracing the box
  const frame = R.buildRuidaJob(p, 'front', ctx, { frameOnly: true });
  assert.equal(frame.parts.length, 1);
  assert.equal(frame.parts[0].power, 0);
  assert.equal(frame.parts[0].paths, 1);
  // mm/min speeds (GRBL profile) are converted to mm/s
  p.laser.machine.speedUnit = 'mm/min';
  p.laser.cut.speed = 1200;
  const j2 = R.buildRuidaJob(p, 'front', ctx, {});
  assert.equal(j2.parts.find((x) => x.name === 'Cut').speed, 20);
});
