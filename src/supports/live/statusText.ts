/**
 * Shared StatusMessage codes (mixo-geocore `editing`, English sentences used as keys) to mixomesh
 * locale keys (plan P3.5). A message the table does not know comes back with its English sentence
 * filled in, so nothing goes blank; `statusKeys.test.ts` pins every key of the editing helpers
 * this app uses.
 */
import type { StatusMessage } from '@mixo-geocore/editing/types';

export const STATUS_KEYS: Readonly<Record<string, string>> = {
  '{name}: {n} automatic contacts generated.': 'supportLive.generated',
  'Regenerated {name}: {n} supports placed. Hand edits kept: {added} added, {removed} removed. Removals reset: {reset}.': 'supportLive.regenerated',
  '{n} customised kept, {m} reset.': 'supportLive.customisedKept',
  'Generated supports for {n} objects.': 'supportLive.generatedMany',
  'Regenerated {n} objects.': 'supportLive.regeneratedMany',
  'Regenerated {n} objects. Hand edits kept: {added} added, {removed} removed. Removals reset: {reset}.': 'supportLive.regeneratedManyHand',
  '{n} contacts were left out: they sit inside another mesh of the object.': 'supportLive.buriedLeftOut',
  'Still unsupported here.': 'supportLive.stillUnsupported',
  'Spot covered.': 'supportLive.spotCovered',
  'Supports are still building.': 'supportLive.stillBuilding',
};

type Translate = (key: string, vars?: Record<string, unknown>) => string;

/** The sentence of a status message (and its second sentence, `then`), translated by `t`. */
export function statusText(message: StatusMessage, t: Translate): string {
  const own = STATUS_KEYS[message.key];
  const vars = message.vars ?? {};
  const text = own
    ? t(own, vars)
    : message.key.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ''));
  return message.then ? `${text} ${statusText(message.then, t)}` : text;
}
