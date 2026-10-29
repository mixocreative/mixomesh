import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { buildScoped } from './scope.mjs';

const scopedPath = new URL('./kit.scoped.css', import.meta.url);

describe('kit.scoped.css', () => {
  it('is up to date with the unchanged mixo-app-style copies', () => {
    expect(readFileSync(scopedPath, 'utf8').replaceAll('\r\n', '\n')).toBe(buildScoped().replaceAll('
', '
'));
  });
  it('has no unscoped selector (cannot restyle legacy panels)', () => {
    const root = postcss.parse(readFileSync(scopedPath, 'utf8'));
    const bad: string[] = [];
    root.walkRules((r) => {
      if (r.parent?.type === 'atrule' && /keyframes/.test((r.parent as postcss.AtRule).name)) return;
      for (const s of r.selectors) if (!s.trim().startsWith('.mx-kit')) bad.push(s);
    });
    expect(bad).toEqual([]);
  });
});
