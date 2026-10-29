/** Number text <-> value for NumberField. Forgiving: "2mm", "2,5", full-width digits, "1.5x". */
export type NumberUnit = 'mm' | 'deg' | '×' | (string & {});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Parses typed text; returns undefined when no number can be read. */
export function parseNumber(text: string, unit?: string): number | undefined {
  let s = text.normalize('NFKC').trim().toLowerCase();
  if (unit) {
    const u = unit.normalize('NFKC').toLowerCase();
    s = s.replace(new RegExp(`\\s*${u === '×' ? '[×x]' : escapeRe(u)}\\s*$`), '');
    if (unit === 'deg') s = s.replace(/\s*°\s*$/, '');
  }
  s = s.replace(',', '.');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export function clampNumber(n: number, min?: number, max?: number): number {
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

/** Decimal places of a step (0.05 -> 2). */
export function decimalsOf(step: number): number {
  const s = String(step);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  return (s.split('.')[1] ?? '').length;
}

/** Rounds away float noise and drops trailing zeros. */
export function formatNumber(n: number, precision = 3): string {
  return String(Number(n.toFixed(precision)));
}
