/**
 * Catalog/overlay CSV parser (M3) — pure, no GL/DOM. The SSG-grade "CSV of
 * RA/Dec" ingestion path; the React path passes `MarkerInput[]` objects directly,
 * so the CSV columns are named identically to `MarkerInput` fields — one schema,
 * two entry points.
 *
 * Format (frozen as v1; the roadmap finalizes the overlay format by end of M4):
 *   - An optional `# fitsgl-catalog v1` version line; any other major version is
 *     rejected so a future breaking change is detectable, not silently misread.
 *   - Other `#` lines and blank lines are comments.
 *   - A header row names the columns. Recognized (case-insensitive): `ra`, `dec`,
 *     `x`, `y`, `id`, `shape`, `size`, `color`, `edgewidth`/`edge_width`/`edge`.
 *     Any other column is preserved verbatim into `marker.data` (e.g. `flux`).
 *   - Coordinates are DECIMAL DEGREES (ra/dec) or 0-based pixels (x/y); a row
 *     needs ra+dec together or x+y together, else it is dropped (warn-once).
 *   - Minimal RFC4180 quoting: double-quoted fields may contain commas, and `""`
 *     is an escaped quote.
 */

import { type MarkerInput } from './markers.js';

/** The catalog format major version this parser produces/accepts. */
export const CATALOG_VERSION = 1;

const VERSION_RE = /^#\s*fitsgl-catalog\s+v(\d+)/i;

const EDGE_ALIASES = new Set(['edgewidth', 'edge_width', 'edge']);

/** Split one CSV line into fields, honouring `"..."` quoting and `""` escapes. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (line.charAt(i + 1) === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Parse a finite number, or undefined for empty / non-numeric (e.g. `nan`). */
function finiteOrUndef(s: string): number | undefined {
  const t = s.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * A data-cell value: a finite number if parseable, otherwise the trimmed string.
 * Empty and non-finite numeric tokens (`nan`, `inf`, ... — what pandas `na_rep`
 * emits for a missing value) resolve to undefined so the key is simply absent,
 * matching how coordinate NaNs are dropped rather than surfacing the string
 * `"nan"` to a host.
 */
function dataValue(s: string): number | string | undefined {
  const t = s.trim();
  if (t === '') return undefined;
  const n = Number(t);
  if (Number.isFinite(n)) return n;
  const lc = t.toLowerCase();
  if (lc === 'nan' || lc === 'inf' || lc === '+inf' || lc === '-inf' || lc === 'infinity' || lc === '+infinity' || lc === '-infinity') {
    return undefined;
  }
  return t;
}

function isCommentOrBlank(line: string): boolean {
  const t = line.trim();
  return t === '' || t.charAt(0) === '#';
}

/**
 * Parse catalog CSV text into `MarkerInput[]`. Throws on an unsupported major
 * version or a missing/empty header. Malformed rows (wrong column count, or
 * lacking a complete coordinate) are dropped with a single console warning.
 */
export function parseCatalogCSV(text: string): MarkerInput[] {
  // Strip a UTF-8 BOM and split on LF or CRLF.
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);

  let header: string[] | null = null;
  const markers: MarkerInput[] = [];
  let dropped = 0;

  for (const raw of lines) {
    const versionMatch = VERSION_RE.exec(raw.trim());
    if (versionMatch !== null) {
      const major = Number(versionMatch[1]);
      if (major !== CATALOG_VERSION) {
        throw new Error(
          `parseCatalogCSV: unsupported catalog version v${major} (expected v${CATALOG_VERSION}).`,
        );
      }
      continue;
    }
    if (isCommentOrBlank(raw)) continue;

    const fields = splitCsvLine(raw);
    if (header === null) {
      header = fields.map((h) => h.trim().toLowerCase());
      continue;
    }
    if (fields.length !== header.length) {
      dropped++;
      continue;
    }

    const input: MarkerInput = {};
    const data: Record<string, unknown> = {};
    let hasData = false;
    for (let c = 0; c < header.length; c++) {
      const key = header[c];
      const val = fields[c];
      if (key === 'ra') input.ra = finiteOrUndef(val);
      else if (key === 'dec') input.dec = finiteOrUndef(val);
      else if (key === 'x') input.x = finiteOrUndef(val);
      else if (key === 'y') input.y = finiteOrUndef(val);
      else if (key === 'size') input.size = finiteOrUndef(val);
      else if (EDGE_ALIASES.has(key)) input.edgeWidth = finiteOrUndef(val);
      else if (key === 'id') {
        const t = val.trim();
        if (t !== '') input.id = t;
      } else if (key === 'shape') {
        const t = val.trim();
        if (t !== '') input.shape = t as MarkerInput['shape'];
      } else if (key === 'color') {
        const t = val.trim();
        if (t !== '') input.color = t;
      } else {
        const dv = dataValue(val);
        if (dv !== undefined) {
          data[key] = dv;
          hasData = true;
        }
      }
    }

    const hasSky = input.ra !== undefined && input.dec !== undefined;
    const hasPix = input.x !== undefined && input.y !== undefined;
    if (!hasSky && !hasPix) {
      dropped++;
      continue;
    }
    if (hasData) input.data = data;
    markers.push(input);
  }

  if (header === null) {
    throw new Error('parseCatalogCSV: no header row found.');
  }
  if (dropped > 0) {
    console.warn(`parseCatalogCSV: dropped ${dropped} malformed/incomplete row(s).`);
  }
  return markers;
}
