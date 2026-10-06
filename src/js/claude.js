// Claude integration for the editor page (works in the desktop app and in a
// browser). The API key is entered in Settings → Claude AI, or in the popup
// that appears the first time an AI feature is used.
//  • imagine(): text prompt → new editable design
//  • fromImage(): picture of a design → editable text, shapes and image pieces
// Coordinates come back as fractions (0–1) of the workspace / picture so the
// editor can place them at any size.
import { Anthropic, zodOutputFormat, z } from '../vendor/claude-sdk.mjs';

const MODEL = 'claude-opus-5-5';
const STORE_KEY = 'lcx.claudeKey';
const desktop = typeof window !== 'undefined' ? window.lcx : null;

// ---------- key storage ----------
// Desktop: encrypted by the OS keychain (Electron safeStorage).
// Browser: this browser's local storage for this page only.

export async function getKey() {
  if (desktop?.secret) return (await desktop.secret.get('claude')) || '';
  try {
    return localStorage.getItem(STORE_KEY) || '';
  } catch {
    return '';
  }
}

async function storeKey(key) {
  if (desktop?.secret) return desktop.secret.set('claude', key);
  try {
    if (key) localStorage.setItem(STORE_KEY, key);
    else localStorage.removeItem(STORE_KEY);
  } catch {
    /* storage blocked: the key is kept for this session only */
  }
}

let sessionKey = '';

export async function isSignedIn() {
  return !!(sessionKey || (await getKey()));
}

async function client() {
  const apiKey = sessionKey || (await getKey());
  if (!apiKey) throw new NeedsKeyError();
  // The page talks to Claude directly with the user's own key.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

export class NeedsKeyError extends Error {
  constructor() {
    super('Add your Claude API key in Settings → Claude AI.');
    this.needsKey = true;
  }
}

// Verifies and saves a key. Throws a readable error if the key does not work.
export async function saveKey(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('Paste your Claude API key.');
  try {
    await new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true }).models.retrieve(MODEL);
  } catch (err) {
    throw new Error(friendly(err));
  }
  sessionKey = key;
  await storeKey(key);
}

export async function forgetKey() {
  sessionKey = '';
  await storeKey('');
}

// ---------- schema ----------

function layoutSchema(opts) {
  const Element = z.object({
    kind: z.enum(['text', 'rect', 'ellipse', 'line', 'polygon', 'star', 'qr', 'chip', 'contactless', 'graphic']),
    name: z.string(),
    side: z.enum(['front', 'back']),
    op: z.enum(['engrave', 'score', 'cut']),
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
    rotation: z.number(),
    text: z.string().nullable(),
    font: z.enum(opts.fonts).nullable(),
    bold: z.boolean().nullable(),
    align: z.enum(['left', 'center', 'right']).nullable(),
    letterSpacing: z.number().nullable(),
    format: z.enum(opts.formats).nullable(),
    cornerRadius: z.number().nullable(),
    polygonSides: z.number().nullable(),
    qrData: z.string().nullable(),
  });
  return z.object({
    title: z.string(),
    preset: z.enum(opts.presets),
    material: z.enum(opts.materials),
    elements: z.array(Element),
  });
}

const RULES = `Coordinates: x, y, w, h are FRACTIONS (0–1) of the full width/height of the area, measured from its top-left corner. x,y is the top-left of the item's box.
Element kinds:
- text: set text (use \\n for line breaks), font, bold, align, letterSpacing (mm, usually 0–1). The box height should tightly fit the lines of text.
- rect / ellipse: shapes; cornerRadius in mm for rect. line: a thin horizontal rule (h very small).
- polygon / star: polygonSides = number of corners/points.
- qr: qrData = link or text. chip: EMV chip pocket. contactless: contactless symbol.
- graphic: a logo, emblem, photo or illustration that is not text or a simple shape.
Operations: engrave = filled engraving (text, solid shapes), score = thin outline engraving (borders, rings, rules), cut = cut through (holes, outlines of parts).
Use format "cardnumber" for card numbers, "expiry" for MM/YY dates, "upper" for uppercase names, "digits" for codes, otherwise "none".
Rotation in degrees (0 for normal items).`;

async function run(content, opts, effort) {
  const c = await client();
  let res;
  try {
    res = await c.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      // if Claude Opus 5.5 declines, the API retries on its recommended fallback model
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort, format: zodOutputFormat(layoutSchema(opts)) },
      messages: [{ role: 'user', content }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new NeedsKeyError();
    throw new Error(friendly(err));
  }
  if (res.stop_reason === 'refusal') throw new Error('Claude declined this request. Try describing it differently.');
  if (res.stop_reason === 'max_tokens') throw new Error('The design was too large to finish. Try a simpler request.');
  if (!res.parsed_output) throw new Error('Claude returned an unreadable layout. Please try again.');
  return res.parsed_output;
}

// opts: { prompt, workspace: {w,h,label}, fonts, formats, presets, materials }
export async function imagine(opts) {
  const text = `You design laser-engraved products (metal business cards, metal credit cards, signs, coasters, tags…).
Create a clean, well-balanced, production-ready layout for this request:

"""${opts.prompt}"""

Current workspace: ${opts.workspace.label} (${opts.workspace.w} × ${opts.workspace.h} mm). Pick the "preset" that best fits the request (keep the current one if it fits) and a "material".
Put the main design on side "front"; use "back" only for two-sided items like cards.
Keep everything at least 3 mm from the edges. Use realistic placeholder content the user can edit. Never use real company trademarks or logos – invent neutral names. Use kind "graphic" only as a placeholder box where the user should add their own artwork.
Available fonts: ${opts.fonts.join(', ')}.
${RULES}`;
  return run([{ type: 'text', text }], opts, 'medium');
}

// opts: { image: base64, mediaType, fonts, formats, presets, materials }
export async function fromImage(opts) {
  const text = `This is a picture of a design (for example a card, sign or label). Rebuild it as editable layers for a laser engraving editor.
Transcribe every piece of text exactly as written, choose the closest available font (${opts.fonts.join(', ')}), and match each item's position and size as precisely as you can.
Recreate simple geometric parts (borders, rules, circles, ovals, ribbons, chip, contactless symbol) as shapes. Mark logos, emblems, portraits, photos and other artwork as kind "graphic" with a tight box around them – they will be cut out of the picture.
Coordinates are fractions of the PICTURE's width and height. Put everything on side "front". For "preset" pick the closest workspace (credit cards: "iso"); for "material" pick the closest colour.
${RULES}`;
  return run(
    [
      { type: 'image', source: { type: 'base64', media_type: opts.mediaType, data: opts.image } },
      { type: 'text', text },
    ],
    opts,
    'high'
  );
}

function friendly(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'That API key was not accepted. Check it and try again.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'This API key is not allowed to use Claude.';
  if (err instanceof Anthropic.RateLimitError) return 'Claude is busy (rate limit). Wait a moment and try again.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach Claude – check your internet connection.';
  if (err instanceof Anthropic.APIError) return `Claude error ${err.status}: ${err.message}`;
  return err?.message || String(err);
}
