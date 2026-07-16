// Render output (Scene ▸ Rendering) — façade over core/render/*. Produces
// PNG stills and turntable videos; the render-view toggle + frame overlay
// (compose aids) live in ui/ScenePanel.js + ui/RenderFrame.js.
//
//   FrameCapture.js      RTT pipeline: capturePng (WebGL + WebGPU paths),
//                        captureFrameRGBA, offline frame renderer, furniture hide
//   SweepRig.js          rigid camera/lights/env turntable rotation (shared)
//   TurntablePreview.js  live viewport sweep, owns the preview handle
//   VideoRecorder.js     offline WebCodecs encode → mp4, owns the recording flag
//
// The export names below are a frozen contract: ui/ScenePanel.js,
// core/PersistenceManager.js and the browser smokes (which dynamic-import
// this path directly) all consume them.

import { EVENTS } from './events.js';
import { subscribe } from './StateManager.js';
import { capturePng, captureFrameRGBA } from './render/FrameCapture.js';
import {
  previewTurntable, stopPreview, isPreviewing,
  cancelForProjectSwitch as _cancelPreview,
} from './render/TurntablePreview.js';
import {
  recordTurntable, isRecording,
  cancelForProjectSwitch as _cancelRecording,
} from './render/VideoRecorder.js';

export {
  capturePng, captureFrameRGBA,
  previewTurntable, stopPreview, isPreviewing,
  recordTurntable, isRecording,
};

// A project switch mid-capture must kill the sweep/encode immediately AND
// must NOT restore the pre-capture camera afterwards — the loaded/new
// project's camera wins (audit C2). Lights/env still restore: they are
// app-fixed studio rig state, not project state.
const _onProjectSwitch = () => {
  _cancelPreview();
  _cancelRecording();
};
subscribe(EVENTS.PROJECT_NEW, _onProjectSwitch);
subscribe(EVENTS.PROJECT_LOADED, _onProjectSwitch);
