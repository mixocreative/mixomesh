/**
 * The raft label text (plan P5.4): at most 8 characters of A-Z, 0-9 and "-", uppercase. What the
 * user types is filtered to that set (other characters are rejected with a hint in the panel);
 * with no text of its own the label is the object's name made to fit the same rules.
 */
export const LABEL_MAX = 8;

/** Uppercase, only A-Z 0-9 -, at most 8 characters. */
export function sanitizeLabel(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, LABEL_MAX);
}

/** An object name as a label: spaces and dots become "-", everything else outside the set is dropped. */
export function labelFromName(name: string): string {
  return sanitizeLabel(name.trim().replace(/[\s._]+/g, '-').replace(/^-+|-+$/g, ''));
}

/** The label a job carries: the user's text when it has any valid character, else the object name, else "A". */
export function labelTextFor(userText: string, objectName: string): string {
  return sanitizeLabel(userText) || labelFromName(objectName) || 'A';
}
