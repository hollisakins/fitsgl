/**
 * Sexagesimal formatting for the RA/Dec readout. Pure string math, no deps.
 *
 * RA is shown in time units (hours:minutes:seconds); Dec in signed
 * degrees:arcminutes:arcseconds. Both round to a fixed number of decimal places
 * and carry units forward correctly (so 59.9996s rounds up to the next minute
 * rather than printing "60.000s").
 */

function sexagesimal(value: number, secondsDecimals: number): {
  whole: number;
  minutes: number;
  seconds: number;
} {
  // Split |value| into whole/min/sec, then renormalize after rounding seconds so
  // a rounded-up 60 carries into minutes (and 60 minutes into the whole part).
  const abs = Math.abs(value);
  let whole = Math.floor(abs);
  let minutes = Math.floor((abs - whole) * 60);
  let seconds = (abs - whole - minutes / 60) * 3600;
  const factor = 10 ** secondsDecimals;
  seconds = Math.round(seconds * factor) / factor;
  if (seconds >= 60) {
    seconds -= 60;
    minutes += 1;
  }
  if (minutes >= 60) {
    minutes -= 60;
    whole += 1;
  }
  return { whole, minutes, seconds };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function padSeconds(s: number, decimals: number): string {
  const str = s.toFixed(decimals);
  return s < 10 ? `0${str}` : str;
}

/** Format an RA in degrees as `HH:MM:SS.sss` (time units). */
export function formatRA(raDeg: number, decimals = 3): string {
  // Normalize to [0, 360) so 360 wraps to 0, then convert degrees -> hours.
  const norm = ((raDeg % 360) + 360) % 360;
  const hours = norm / 15;
  const { whole, minutes, seconds } = sexagesimal(hours, decimals);
  // hours can reach 24 only via rounding at 359.9999.. -> wrap to 0.
  const h = whole % 24;
  return `${pad2(h)}:${pad2(minutes)}:${padSeconds(seconds, decimals)}`;
}

/** Format a Dec in degrees as `±DD:MM:SS.ss`. */
export function formatDec(decDeg: number, decimals = 2): string {
  const { whole, minutes, seconds } = sexagesimal(decDeg, decimals);
  // Sign from the rounded value, so a tiny negative that rounds to zero prints
  // `+00:00:00` rather than `-00:00:00`.
  const sign = decDeg < 0 && (whole > 0 || minutes > 0 || seconds > 0) ? '-' : '+';
  return `${sign}${pad2(whole)}:${pad2(minutes)}:${padSeconds(seconds, decimals)}`;
}

/** Convert a 1- or 3-token coordinate field to degrees. 1 token = decimal degrees
 *  (a decimal RA is already in degrees). 3 tokens = sexagesimal; RA tokens are in
 *  hours (×15 → degrees), Dec tokens in degrees. Returns null on a non-numeric token. */
function fieldToDeg(tokens: string[], isRa: boolean): number | null {
  const nums = tokens.map((t) => Number(t));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  if (tokens.length === 1) return nums[0]!; // decimal degrees
  if (tokens.length === 3) {
    const sign = tokens[0]!.trim().startsWith('-') ? -1 : 1;
    const val = Math.abs(nums[0]!) + nums[1]! / 60 + nums[2]! / 3600;
    return sign * (isRa ? val * 15 : val);
  }
  return null;
}

/**
 * Parse a free-form RA/Dec string into ICRS degrees, or `null` if unparseable.
 * The inverse direction of `formatRA`/`formatDec`, for a "go to coordinates" box.
 * Accepts decimal degrees (`"150.12 2.34"`, `"150.12, 2.34"`) and sexagesimal
 * (`"10:00:00 +02:12:00"`, `"10 00 00 -02 12 00"`, `"10h00m00s +02d12m00s"`). RA in
 * sexagesimal is read as hours; decimal RA is read as degrees. Rejects out-of-range
 * results (RA∉[0,360], Dec∉[−90,90]). No frame conversion — ICRS only (D4).
 */
export function parseSkyCoord(input: string): { ra: number; dec: number } | null {
  // Strip h/m/s/d/'/" unit letters and :/, separators down to space-delimited numbers.
  const norm = input.trim().replace(/[hHdDmMsS'":,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (norm === '') return null;
  const toks = norm.split(' ');
  // The Dec field starts at the first signed token after the RA (RA is unsigned).
  let split = -1;
  for (let i = 1; i < toks.length; i++) {
    if (/^[+-]/.test(toks[i]!)) {
      split = i;
      break;
    }
  }
  let raToks: string[];
  let decToks: string[];
  if (split !== -1) {
    raToks = toks.slice(0, split);
    decToks = toks.slice(split);
  } else if (toks.length === 2) {
    raToks = [toks[0]!];
    decToks = [toks[1]!];
  } else if (toks.length === 6) {
    raToks = toks.slice(0, 3);
    decToks = toks.slice(3);
  } else {
    return null;
  }
  const ra = fieldToDeg(raToks, true);
  const dec = fieldToDeg(decToks, false);
  if (ra === null || dec === null) return null;
  if (!(ra >= 0 && ra <= 360) || !(dec >= -90 && dec <= 90)) return null;
  return { ra, dec };
}
