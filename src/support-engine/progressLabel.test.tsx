import { describe, expect, it } from 'vitest';
import { PROGRESS_STAGE } from '@mixo-geocore/host/core/progress';
import en from '../i18n/locales/en.json';
import ja from '../i18n/locales/ja.json';
import zhHant from '../i18n/locales/zh-Hant.json';
import { progressLabel } from './progressLabel';

describe('progressLabel', () => {
  it('has a translation in every locale for every stage code the engine host reports', () => {
    for (const code of Object.values(PROGRESS_STAGE)) {
      for (const locale of [en, ja, zhHant] as Record<string, string>[]) expect(locale[code], code).toBeTruthy();
    }
  });

  it('maps a code to text and passes an unknown code through', () => {
    expect(progressLabel(PROGRESS_STAGE.done)).not.toBe(PROGRESS_STAGE.done);
    expect(progressLabel('something.new')).toBe('something.new');
  });
});
