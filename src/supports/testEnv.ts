// Test-only side-effect module: import it FIRST in a node vitest file that loads src/core modules.
// They read window / location / window.BABYLON at module evaluation; a permissive Babylon stub is
// enough because these tests never touch a scene (react.test.tsx uses the same stub in jsdom).
// `localhost` turns on the dev deep-freeze of getState(), which also proves state is JSON-safe.
const g = globalThis as unknown as { window?: unknown; location?: unknown; BABYLON?: unknown };
const stub = (): unknown => new Proxy(function () {}, {
  get: (_t, k) => (k === Symbol.toPrimitive ? () => 0 : stub()),
  apply: () => stub(),
  construct: () => stub() as object,
});
g.window ??= globalThis;
g.location ??= { hostname: 'localhost', href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:', search: '', hash: '' };
g.BABYLON ??= stub();

export {};
