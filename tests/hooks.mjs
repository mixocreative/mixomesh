// Resolver hook: map the bare 'jszip' specifier to a local stub so
// PrintManager's `await import('jszip')` works under Node.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'jszip') {
    return { url: new URL('./jszip-stub.mjs', import.meta.url).href, shortCircuit: true };
  }
  // No IndexedDB under Node — swap idb.js for an in-memory stub so
  // PersistenceManager's handle/kv calls work in the headless tests.
  if (specifier === './idb.js') {
    return { url: new URL('./idb-stub.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
