// Copies third-party browser libraries and fonts from node_modules into src/vendor.
// Run with `npm run vendor` after upgrading any of these packages.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const nm = (p) => path.join(root, 'node_modules', p);
const out = path.join(root, 'src', 'vendor');
fs.mkdirSync(path.join(out, 'fonts'), { recursive: true });

const copy = (from, to) => {
  fs.copyFileSync(nm(from), path.join(out, to));
  console.log('copied', to);
};

copy('opentype.js/dist/opentype.mjs', 'opentype.mjs');
copy('opentype.js/LICENSE', 'opentype.LICENSE.txt');
copy('qrcode-generator/dist/qrcode.mjs', 'qrcode.mjs');

// [package, file prefix, weights]
const fonts = [
  ['roboto', 'roboto', [400, 700]],
  ['montserrat', 'montserrat', [400, 700]],
  ['playfair-display', 'playfair-display', [400, 700]],
  ['roboto-mono', 'roboto-mono', [400, 700]],
  ['orbitron', 'orbitron', [400, 700]],
  ['great-vibes', 'great-vibes', [400]],
];
for (const [pkg, prefix, weights] of fonts) {
  for (const w of weights) {
    copy(`@fontsource/${pkg}/files/${prefix}-latin-${w}-normal.woff`, `fonts/${prefix}-${w}.woff`);
  }
  copy(`@fontsource/${pkg}/LICENSE`, `fonts/${prefix}.LICENSE.txt`);
}
