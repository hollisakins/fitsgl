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
