/**
 * Shareable view-state URLs for the explorer (decision: on-demand, NOT live).
 *
 * The view is encoded into the URL hash ONLY when the user asks for it (the
 * right-click "Copy view link"); the URL is never mutated on pan/zoom, so the
 * browser Back button is never polluted with a trail of camera moves (the
 * fitsmap anti-pattern). The camera is sky-anchored (ra/dec + zoom) so a link
 * survives a rebuild as long as the WCS is consistent.
 *
 * Pure string math here (encode/decode/parse); the explorer does the window +
 * viewer access. Unit-tested in `share-url.test.ts`.
 */

/** The user-controllable view state carried in a shared link (compact keys). */
export interface ShareState {
  /** Sky-anchored camera: [raDeg, decDeg, zoom]. */
  c?: [number, number, number];
  /** Layer mode. */
  m?: 'single' | 'rgb';
  /** Active single-band name. */
  b?: string;
  /** RGB channel band names [r, g, b]. */
  rgb?: [string, string, string];
  /** Stretch mode name. */
  s?: string;
  /** Colormap name. */
  cm?: string;
  /** North-up: 1 on, 0 off. */
  n?: 0 | 1;
  /** Coordinate grid (graticule): 1 on, 0 off. */
  g?: 0 | 1;
}

/** UTF-8-safe base64url (no `+`/`/`/`=`), so band names with any character survive. */
function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Encode a view state to the opaque token that rides in the `#v=` hash param. */
export function encodeShareState(state: ShareState): string {
  return b64urlEncode(JSON.stringify(state));
}

/**
 * Extract + decode the view state from a URL hash (e.g. `'#v=...'` or
 * `'#a=1&v=...'`), or `null` when absent/malformed. Never throws.
 */
export function decodeShareHash(hash: string): ShareState | null {
  const m = /[#&]v=([^&]+)/.exec(hash);
  if (m === null) return null;
  try {
    const obj: unknown = JSON.parse(b64urlDecode(m[1]!));
    if (typeof obj !== 'object' || obj === null) return null;
    return obj as ShareState;
  } catch {
    return null; // malformed token — treat as no share state, not an error
  }
}

/** Build a full shareable URL: `base` with its hash replaced by the encoded state. */
export function buildShareUrl(base: string, state: ShareState): string {
  const url = new URL(base);
  url.hash = `v=${encodeShareState(state)}`;
  return url.toString();
}
