# LaserCutX – Metal Card Designer

A simple desktop app (Windows & macOS) for designing **metal business cards** and
**custom metal credit cards**, then exporting laser-ready files.

![Editing a metal credit card with Quick Fill](docs/screenshot-credit-card.png)

## What it does

- **Templates** – metal credit card (front + back) and metal business card, or start blank.
- **Quick Fill** – every name, number and QR link is listed in a simple form on the left.
  Just type: card numbers group themselves (`4000 1234 5678 9010`, Amex `3782 822463 10005`),
  expiry becomes `MM/YY`, the card-holder name becomes UPPERCASE.
- **Start from an image of a card** – load a photo/scan/PNG of a design, put an
  **Erase box** over the old name or number, type the new text on top, then
  **Convert to vector (trace)** so the SVG/DXF contains clean laser paths.

  ![Replacing a number on an imported card image](docs/screenshot-image-edit.png)
- **Add** text (6 built-in fonts + load your own TTF/OTF/WOFF), rectangles, circles,
  EMV **chip pocket**, **QR codes**, **key-ring holes**, images and **SVG logos**.
- **Exports** (true millimetre size, ISO ID-1 card = 85.60 × 53.98 mm, r 3.18 mm):

  | Format | Use with | Notes |
  |---|---|---|
  | **SVG** | LightBurn, xTool Creative Space, Glowforge, Inkscape | Black = engrave fill, Blue = line engrave, Red = cut. Text is converted to outlines, so no fonts are needed on the laser PC. |
  | **DXF** (R12) | EzCad (fiber lasers), RDWorks, LaserGRBL, CAD | Layers `ENGRAVE`, `SCORE`, `CUT`. Vectors only – trace images first. |
  | **PNG** | Any raster engraving | 300–1200 DPI, DPI stored in the file so it imports at the right size. Optional invert. |

  Options: front, back or both sides, choose layers, **mirror** for back-side jigs, include/exclude the red card outline.
- Projects save as `.lcx` files (fonts and images included, so they open anywhere).

## Download / install

Ready-made apps are built by GitHub Actions:

1. Open the repository's **Actions** tab → **Build desktop apps** → **Run workflow**
   (or push a tag such as `v1.0.0` to also create a Release).
2. Download the artifact:
   - **Windows:** `LaserCutX Setup 1.0.0.exe` (installer) or `LaserCutX-1.0.0-portable.exe` (no install).
   - **macOS:** `LaserCutX-1.0.0-universal.dmg` (Intel + Apple Silicon).

The apps are not code-signed, so the first launch shows a warning:
- **Windows SmartScreen:** click *More info → Run anyway*.
- **macOS:** right-click the app → *Open* → *Open* (or System Settings → Privacy & Security → *Open Anyway*).

## Run from source

Requires [Node.js](https://nodejs.org) 20+.

```bash
npm install
npm start          # desktop app
npm run web        # or run it in your browser at http://localhost:5173
npm test           # unit tests
npm run dist:win   # build Windows .exe   (run on Windows)
npm run dist:mac   # build macOS .dmg     (run on a Mac)
```

## Tips for metal cards

- Fiber lasers (EzCad): export **DXF** and set fill/hatch for the `ENGRAVE` layer in EzCad.
- CO₂/diode with marking spray or LightBurn: export **SVG**; layers are picked up by colour.
- The **chip pocket** position follows ISO 7816-2 approximately – check it against your chip module before cutting.
- Keep text inside the dashed **safe area** (2.5 mm from the edge).
- Use **Mirror** when engraving the back of a card in a flipped fixture.

## Project layout

```
electron/          desktop shell (window, menu, native save dialogs)
src/index.html     editor UI
src/js/app.js      editor logic
src/js/model.js    card sizes, templates, element → vector geometry
src/js/exporters.js SVG / DXF / raster export
src/js/trace.js    image → vector tracing
src/js/imaging.js  erase boxes, PNG rendering, SVG logo import
src/vendor/        opentype.js, qrcode-generator, fonts (OFL) – refresh with `npm run vendor`
tests/             unit tests (node --test)
```

Fonts are licensed under the SIL Open Font License; see `src/vendor/fonts/*.LICENSE.txt`.
