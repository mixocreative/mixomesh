// Off-screen render mutex.
//
// Every off-screen capture (asset thumbnails, PNG stills, the offline video
// encoder, the save-time recent-projects thumbnail) temporarily overrides
// `engine.getRenderWidth/Height` and `engine.skipFrameRender` — Babylon's
// Tools.CreateScreenshotUsingRenderTarget does it internally, FrameCapture's
// renderSceneToTarget mirrors it. The overrides save the PREVIOUS function
// and put it back when done, so two captures in flight at once nest: A saves
// the real function, B saves A's override, A restores the real one, then B
// "restores" A's override — and the engine is left reporting A's capture
// size forever. Seen live 2026-09-18: two files dropped together queued two
// 128×128 thumbnails concurrently and the viewport rendered into a 128×128
// corner of the canvas until reload.
//
// One promise chain serialises them all. Cheap (captures are rare) and it
// makes the nesting impossible instead of merely unlikely.

let _tail = Promise.resolve();

/**
 * Run `fn` when no other off-screen capture is in flight. Errors propagate
 * to the caller and never break the chain for the next caller.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withRenderLock(fn) {
  const run = _tail.then(fn, fn);
  _tail = run.then(() => undefined, () => undefined);
  return run;
}
