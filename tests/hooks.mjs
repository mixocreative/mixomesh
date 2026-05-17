// Resolver hook: map the bare 'jszip' specifier (browser importmap-only) to a
// local stub so PrintManager's `await import('jszip')` works under Node.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'jszip') {
    return { url: new URL('./jszip-stub.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
