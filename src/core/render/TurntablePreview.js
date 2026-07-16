// Turntable preview — plays the sweep live in the viewport, no recording.
// Owns the preview handle; VideoRecorder owns the recording flag (imported
// here one-directionally so preview and record can't overlap).

import { SceneManager } from '../SceneManager.js';
import { startSweep } from './SweepRig.js';
import { isRecording } from './VideoRecorder.js';

let _preview = null;   // { cancel } while a preview sweep plays

/** @returns {boolean} a turntable preview is playing */
export function isPreviewing() { return !!_preview; }

/**
 * Play the turntable live in the viewport — no recording. Esc, hiding the
 * tab, or stopPreview() stops it early; rig is restored either way.
 * @returns {Promise<'done'|'cancelled'|null>} null when already busy
 */
export function previewTurntable({ durationS = 8, direction = 'left', ease = true,
                                   onProgress } = {}) {
  if (isRecording() || _preview) return Promise.resolve(null);
  const engine = SceneManager.getEngine();
  const scene  = SceneManager.getScene();
  const camera = SceneManager.getCamera();
  if (!engine || !scene || !camera) return Promise.reject(new Error('Scene not ready'));
  const canvas = engine.getRenderingCanvas();

  return new Promise((resolve) => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); sweep.cancel(); }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') sweep.cancel();
    };
    const sweep = startSweep({
      durationS, direction, ease, onProgress,
      onComplete: (result) => {
        window.removeEventListener('keydown', onKey, true);
        document.removeEventListener('visibilitychange', onVisibility);
        canvas.style.pointerEvents = '';
        _preview = null;
        resolve(result);
      },
    });
    _preview = sweep;
    canvas.style.pointerEvents = 'none';
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('visibilitychange', onVisibility);
  });
}

/** Stop a playing preview early (rig restored). */
export function stopPreview() { _preview?.cancel(); }

/** Kill a playing preview on project switch — camera NOT restored (new project's camera wins). */
export function cancelForProjectSwitch() { _preview?.cancel('project'); }
