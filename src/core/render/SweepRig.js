// Turntable sweep rig — shared by the live preview (TurntablePreview) and the
// offline recorder (VideoRecorder). Extracting it here keeps those two modules
// from importing each other.
//
// RIGID rotation of the whole camera rig around the WORLD vertical axis
// through the origin — the camera is NEVER re-aimed and NEVER pans: the
// framing you start with is exactly what rotates. Per-frame, the same
// world rotation is applied to the camera (alpha + target together) so the
// rig's pose relative to the world is a pure rotation about the origin
// axis; on screen, the world spins about where the origin projects while
// the composition is preserved. No jump at start, no drift.
//
// The directional studio lights AND (when one exists)
// scene.environmentTexture rotate by the same angle — lights moving with
// the camera is what makes it read as "model spinning on a turntable under
// fixed studio lighting" instead of "camera flying around the model".
//
// The world matrix is RotationY(−δ) for camera alpha +δ (ArcRotate's α
// moves the camera +X→+Z while Babylon's RotationY(+θ) maps +X→−Z, so the
// sign flips — verified numerically: |position| stays on the origin circle
// only with this pairing). Hemi light points straight up — no-op.

import { SceneManager } from '../SceneManager.js';
import { turntableProgress } from './RenderMath.js';

const BABYLON = window.BABYLON;

/**
 * Capture everything the sweep touches. Returns { applyDelta, restore } —
 * shared by the live sweep (preview / realtime recording) and the offline
 * frame-by-frame encoder. restore(skipCamera) leaves the camera alone on
 * project-switch cancellation.
 */
export function createSweepRig() {
  const scene  = SceneManager.getScene();
  const camera = SceneManager.getCamera();

  const startPose   = SceneManager.saveCameraState();
  const startAlpha  = camera.alpha;
  const startTarget = camera.target.clone();

  const key  = scene.getLightByName('key');
  const fill = scene.getLightByName('fill');
  const starts = {
    keyDir:  key?.direction.clone(),  keyPos: key?.position.clone(),
    fillDir: fill?.direction.clone(),
    envRot:  scene.environmentTexture?.rotationY ?? 0,
  };

  const applyDelta = (delta) => {
    const m = BABYLON.Matrix.RotationY(-delta);
    camera.alpha = startAlpha + delta;
    // MUTATE the target — the `camera.target = v` SETTER calls setTarget(),
    // which re-aims (rebuilds alpha/beta from the current position) and
    // would silently overwrite the alpha line above. Same reason CameraRig's
    // pan uses addInPlace.
    camera.target.copyFrom(BABYLON.Vector3.TransformCoordinates(startTarget, m));
    if (key) {
      key.direction = BABYLON.Vector3.TransformCoordinates(starts.keyDir, m);
      key.position  = BABYLON.Vector3.TransformCoordinates(starts.keyPos, m);
    }
    if (fill) fill.direction = BABYLON.Vector3.TransformCoordinates(starts.fillDir, m);
    // +δ verified EMPIRICALLY (browser-smoke mirror-sphere probe): with this
    // sign a mid-sweep capture matches the baseline (lighting fixed relative
    // to camera); −δ made the env counter-rotate (sweepDiff > ctrlDiff).
    if (scene.environmentTexture) scene.environmentTexture.rotationY = starts.envRot + delta;
    // The key light moved — the RENDERONCE shadow map must re-render.
    SceneManager.invalidateShadows();
  };

  const restore = (skipCamera = false) => {
    if (!skipCamera) SceneManager.restoreCameraState(startPose);
    if (key)  { key.direction = starts.keyDir;  key.position = starts.keyPos; }
    if (fill) fill.direction = starts.fillDir;
    if (scene.environmentTexture) scene.environmentTexture.rotationY = starts.envRot;
    SceneManager.invalidateShadows();
  };

  return { applyDelta, restore };
}

/**
 * Start a live sweep. Returns { cancel } — cancel(reason) stops early and
 * restores (camera excluded when reason === 'project'). onComplete fires
 * exactly once with 'done' | 'cancelled'.
 */
export function startSweep({ durationS = 8, direction = 'left', ease = true,
                             onProgress, onComplete }) {
  const scene = SceneManager.getScene();
  const durationMs = Math.max(1, durationS) * 1000;
  const { applyDelta, restore } = createSweepRig();

  let startTs = 0;
  let finished = false;
  let observer = null;

  const end = (result, skipCamera = false) => {
    if (finished) return;
    finished = true;
    if (observer) scene.onBeforeRenderObservable.remove(observer);
    observer = null;
    restore(skipCamera);
    onComplete?.(result);
  };

  observer = scene.onBeforeRenderObservable.add(() => {
    const now = performance.now();
    if (!startTs) startTs = now;
    const t = (now - startTs) / durationMs;
    if (t >= 1) { end('done'); return; }
    const sign = direction === 'right' ? -1 : 1;
    applyDelta(sign * 2 * Math.PI * turntableProgress(t, ease));
    onProgress?.(t);
  });

  return { cancel: (reason) => end('cancelled', reason === 'project') };
}
