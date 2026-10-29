/** The label embossed on a dental aligner's raft (Step 3): short, printable, sortable. */
export const DENTAL_LABEL_MAX = 8;
export const DEFAULT_DENTAL_LABEL = 'X';

/**
 * What the Label field accepts: letters (made upper case), digits and "-". Everything else is
 * dropped, and the text is cut at 8 characters. Typing, pasting and drops all go through this.
 */
export function filterDentalLabel(raw: string): string {
  let out = '';
  for (const character of raw) {
    const upper = /[a-z]/.test(character) ? character.toUpperCase() : character;
    if (/^[A-Z0-9-]$/.test(upper)) out += upper;
    if (out.length >= DENTAL_LABEL_MAX) break;
  }
  return out;
}

/** The label a finished aligner carries: its own text, or the default when the field was left empty. */
export function dentalLabelOf(text: string | undefined): string {
  return filterDentalLabel(text ?? '') || DEFAULT_DENTAL_LABEL;
}
