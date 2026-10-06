// Laser file exporters: SVG (LightBurn, xTool, Glowforge, Inkscape…),
// DXF R12 (EzCad, RDWorks, LaserGRBL, CAD) and the SVG used for PNG rasters.
import { rectPath, transformPath, toSvgD, flatten, IDENTITY } from './geometry.js';
import { OPS, elementGeometry } from './model.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const r4 = (n) => Math.round(n * 1e4) / 1e4;

// Collects every exportable element of one side with its geometry.
export function collectSide(project, side, ctx) {
  return (project.sides[side] || [])
    .filter((el) => !el.hidden && el.type !== 'erase' && OPS[el.op])
    .map((el) => ({ el, geo: elementGeometry(el, ctx) }));
}

export function outlinePath(card) {
  return rectPath(0, 0, card.w, card.h, card.radius || 0);
}

function mirrorMatrix(card, mirror) {
  return mirror ? [-1, 0, 0, 1, card.w, 0] : IDENTITY;
}

// Bulk jobs: `sheet` = { count, cols, gap } repeats the card in a grid so one
// laser job makes several cards. Without it the sheet is a single card.
export function sheetLayout(card, sheet) {
  const count = Math.max(1, Math.floor(sheet?.count || 1));
  const cols = Math.max(1, Math.min(count, Math.floor(sheet?.cols || count)));
  const rows = Math.ceil(count / cols);
  const gap = count > 1 ? Math.max(0, sheet?.gap ?? 3) : 0;
  const offsets = [];
  for (let i = 0; i < count; i++) {
    offsets.push([(i % cols) * (card.w + gap), Math.floor(i / cols) * (card.h + gap)]);
  }
  return { offsets, cols, rows, w: cols * card.w + (cols - 1) * gap, h: rows * card.h + (rows - 1) * gap };
}

// One matrix per card copy: mirror each card in place, then move it to its slot.
function placements(card, opts) {
  const layout = sheetLayout(card, opts.sheet);
  const mm = mirrorMatrix(card, opts.mirror);
  return { layout, mats: layout.offsets.map(([dx, dy]) => matMul([1, 0, 0, 1, dx, dy], mm)) };
}

// opts: { layers: ['engrave','score','cut'], mirror, includeOutline, sheet,
//         imageSrc(el) -> data URL to embed (lets the caller apply erase boxes) }
export function toSVG(project, side, ctx, opts = {}) {
  const { card } = project;
  const layers = new Set(opts.layers || Object.keys(OPS));
  const items = collectSide(project, side, ctx);
  const groups = { engrave: [], score: [], cut: [] };
  const { layout, mats } = placements(card, opts);
  const multi = mats.length > 1;

  mats.forEach((mm, ci) => {
    const sfx = multi ? `-c${ci + 1}` : '';
    for (const { el, geo } of items) {
      if (!layers.has(el.op)) continue;
      const color = OPS[el.op].color;
      const label = esc(el.name || el.type) + (multi ? ` (card ${ci + 1})` : '');
      if (geo.raster) {
        const src = opts.imageSrc ? opts.imageSrc(el) : geo.raster.src;
        if (!src) continue;
        const m = matMul(mm, geo.matrix).map(r4).join(' ');
        groups[el.op].push(
          `<image id="${esc(el.id)}${sfx}" data-name="${label}" x="0" y="0" width="${r4(geo.w)}" height="${r4(geo.h)}" preserveAspectRatio="none" transform="matrix(${m})" xlink:href="${src}"/>`,
        );
        continue;
      }
      if (!geo.cmds.length) continue;
      const d = toSvgD(transformPath(geo.cmds, mm));
      if (el.op === 'engrave') {
        groups.engrave.push(
          `<path id="${esc(el.id)}${sfx}" data-name="${label}" d="${d}" fill="${color}" fill-rule="${geo.fillRule}" stroke="none"/>`,
        );
      } else {
        groups[el.op].push(
          `<path id="${esc(el.id)}${sfx}" data-name="${label}" d="${d}" fill="none" stroke="${color}" stroke-width="0.05"/>`,
        );
      }
    }
    if (card.includeOutline && opts.includeOutline !== false && layers.has('cut')) {
      groups.cut.push(
        `<path id="card-outline${sfx}" data-name="Card outline${multi ? ` (card ${ci + 1})` : ''}" d="${toSvgD(transformPath(outlinePath(card), mm))}" fill="none" stroke="${OPS.cut.color}" stroke-width="0.05"/>`,
      );
    }
  });

  const body = Object.entries(groups)
    .filter(([, list]) => list.length)
    .map(
      ([op, list]) => `  <g id="${op}" inkscape:groupmode="layer" inkscape:label="${OPS[op].label}">\n    ${list.join('\n    ')}\n  </g>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Created with LaserCutX. Units: millimetres. Black = engrave fill, Blue = line engrave, Red = cut. -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" version="1.1" width="${r4(layout.w)}mm" height="${r4(layout.h)}mm" viewBox="0 0 ${r4(layout.w)} ${r4(layout.h)}">
${body}
</svg>
`;
}

function matMul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

// SVG for rasterising to PNG: everything that gets marked is black on white.
// opts: { layers, mirror, invert, imageSrc, sheet }
export function toRasterSVG(project, side, ctx, opts = {}) {
  const { card } = project;
  const layers = new Set(opts.layers || ['engrave', 'score']);
  const fg = opts.invert ? '#ffffff' : '#000000';
  const bg = opts.invert ? '#000000' : '#ffffff';
  const parts = [];
  const items = collectSide(project, side, ctx);
  const { layout, mats } = placements(card, opts);
  for (const mm of mats) {
    for (const { el, geo } of items) {
      if (!layers.has(el.op)) continue;
      if (geo.raster) {
        const src = opts.imageSrc ? opts.imageSrc(el) : geo.raster.src;
        if (!src) continue;
        const m = matMul(mm, geo.matrix).map(r4).join(' ');
        const filter = opts.invert ? ' filter="url(#inv)"' : '';
        parts.push(
          `<image x="0" y="0" width="${r4(geo.w)}" height="${r4(geo.h)}" preserveAspectRatio="none" transform="matrix(${m})" href="${src}"${filter}/>`,
        );
      } else if (geo.cmds.length) {
        const d = toSvgD(transformPath(geo.cmds, mm));
        if (el.op === 'engrave') parts.push(`<path d="${d}" fill="${fg}" fill-rule="${geo.fillRule}"/>`);
        else parts.push(`<path d="${d}" fill="none" stroke="${fg}" stroke-width="0.1"/>`);
      }
    }
    if (card.includeOutline && layers.has('cut')) {
      parts.push(`<path d="${toSvgD(transformPath(outlinePath(card), mm))}" fill="none" stroke="${fg}" stroke-width="0.1"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${r4(layout.w)}mm" height="${r4(layout.h)}mm" viewBox="0 0 ${r4(layout.w)} ${r4(layout.h)}">
<defs><filter id="inv"><feColorMatrix type="matrix" values="-1 0 0 0 1 0 -1 0 0 1 0 0 -1 0 1 0 0 0 1 0"/></filter></defs>
<rect x="0" y="0" width="${r4(layout.w)}" height="${r4(layout.h)}" fill="${bg}"/>
${parts.join('\n')}
</svg>`;
}

// DXF R12 (AC1009) with one layer per operation. Curves are flattened into
// polylines; y is flipped because DXF uses y-up.
// Returns { dxf, skipped } where skipped lists raster images that DXF cannot hold.
export function toDXF(project, side, ctx, opts = {}) {
  const { card } = project;
  const layers = new Set(opts.layers || Object.keys(OPS));
  const tol = opts.tolerance || 0.01;
  const { layout, mats } = placements(card, opts);
  const flip = [1, 0, 0, -1, 0, layout.h];
  const skipped = [];
  const ents = [];
  let m;

  const addPath = (cmds, layer) => {
    for (const poly of flatten(transformPath(cmds, m), tol)) {
      ents.push('0', 'POLYLINE', '8', layer, '66', '1', '10', '0', '20', '0', '30', '0', '70', poly.closed ? '1' : '0');
      for (const [x, y] of poly.points) {
        ents.push('0', 'VERTEX', '8', layer, '10', r4(x).toString(), '20', r4(y).toString(), '30', '0');
      }
      ents.push('0', 'SEQEND', '8', layer);
    }
  };

  const items = collectSide(project, side, ctx);
  mats.forEach((mm, ci) => {
    m = matMul(flip, mm);
    for (const { el, geo } of items) {
      if (!layers.has(el.op)) continue;
      if (geo.raster) {
        if (ci === 0) skipped.push(el.name || 'Image');
        continue;
      }
      addPath(geo.cmds, OPS[el.op].dxfLayer);
    }
    if (card.includeOutline && layers.has('cut')) addPath(outlinePath(card), OPS.cut.dxfLayer);
  });

  const layerTable = [];
  for (const op of Object.values(OPS)) {
    layerTable.push('0', 'LAYER', '2', op.dxfLayer, '70', '0', '62', String(op.aci), '6', 'CONTINUOUS');
  }
  const out = [
    '0',
    'SECTION',
    '2',
    'HEADER',
    '9',
    '$ACADVER',
    '1',
    'AC1009',
    '9',
    '$INSUNITS',
    '70',
    '4',
    '9',
    '$MEASUREMENT',
    '70',
    '1',
    '9',
    '$EXTMIN',
    '10',
    '0',
    '20',
    '0',
    '30',
    '0',
    '9',
    '$EXTMAX',
    '10',
    String(r4(layout.w)),
    '20',
    String(r4(layout.h)),
    '30',
    '0',
    '0',
    'ENDSEC',
    '0',
    'SECTION',
    '2',
    'TABLES',
    '0',
    'TABLE',
    '2',
    'LAYER',
    '70',
    String(Object.keys(OPS).length),
    ...layerTable,
    '0',
    'ENDTAB',
    '0',
    'ENDSEC',
    '0',
    'SECTION',
    '2',
    'ENTITIES',
    ...ents,
    '0',
    'ENDSEC',
    '0',
    'EOF',
  ];
  return { dxf: out.join('\r\n') + '\r\n', skipped };
}
