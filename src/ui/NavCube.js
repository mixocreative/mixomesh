import { SceneManager } from '../core/SceneManager.js';

/**
 * Fusion 360-style nav cube anchored top-left of the viewport.
 *
 *   • Click a face → snap to that orthogonal camera preset.
 *   • Drag any part of the cube → orbit the main camera (mirrors MMB drag).
 *   • Home button → reset perspective.
 *
 * Implementation: CSS 3D-transformed DOM cube. A scene render observer keeps
 * the cube's rotateX/Y in sync with the main ArcRotateCamera's alpha/beta.
 */

let _root  = null;
let _cube  = null;
let _scene = null;

const DRAG_THRESHOLD_PX = 4;

export function init() {
  _root = document.getElementById('nav-cube');
  if (!_root) return;
  _root.innerHTML = `
    <div class="nc-cube" id="nc-cube">
      <div class="nc-face nc-front"  data-preset="front"  role="button" tabindex="0">FRONT</div>
      <div class="nc-face nc-back"   data-preset="back"   role="button" tabindex="0">BACK</div>
      <div class="nc-face nc-left"   data-preset="left"   role="button" tabindex="0">LEFT</div>
      <div class="nc-face nc-right"  data-preset="right"  role="button" tabindex="0">RIGHT</div>
      <div class="nc-face nc-top"    data-preset="top"    role="button" tabindex="0">TOP</div>
      <div class="nc-face nc-bottom" data-preset="bottom" role="button" tabindex="0">BOTTOM</div>
    </div>
    <button class="nc-home" id="nc-home" title="Reset perspective view">⌂</button>
  `;
  _cube = document.getElementById('nc-cube');

  _wireFaceClicks();
  _wireDragOrbit();
  _wireHome();
  _wireCameraSync();
}

function _wireFaceClicks() {
  _cube.querySelectorAll('[data-preset]').forEach(face => {
    const activate = (e) => {
      if (face._suppressClick) { face._suppressClick = false; return; }
      e.stopPropagation();
      SceneManager.setCameraPreset(face.dataset.preset);
    };
    face.addEventListener('click', activate);
    face.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      activate(e);
    });
  });
}

function _wireHome() {
  document.getElementById('nc-home').addEventListener('click', () => {
    SceneManager.setCameraPreset('perspective');
  });
}

function _wireDragOrbit() {
  let dragging = false;
  let downX = 0, downY = 0;
  let lastX = 0, lastY = 0;
  let moved = false;
  let activeFace = null;

  const onMove = (e) => {
    if (!dragging) return;
    if (!moved && (Math.abs(e.clientX - downX) > DRAG_THRESHOLD_PX ||
                   Math.abs(e.clientY - downY) > DRAG_THRESHOLD_PX)) {
      moved = true;
      if (activeFace) activeFace._suppressClick = true;
    }
    if (!moved) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    _orbitMainCamera(dx, dy);
  };
  const onUp = () => {
    dragging = false;
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup',   onUp);
  };

  // No preventDefault / setPointerCapture on pointerdown — those suppress the
  // synthesized click on the cube faces, breaking the snap-to-view UX. We
  // route move/up through document so a drag that leaves the cube still works,
  // and a click that never moves still produces a normal `click` event.
  _cube.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    downX = lastX = e.clientX;
    downY = lastY = e.clientY;
    activeFace = e.target.closest('[data-preset]') ?? null;
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup',   onUp, { once: true });
  });
}

function _orbitMainCamera(dx, dy) {
  _scene ??= SceneManager.getScene();
  const cam = _scene?.activeCamera;
  if (!cam) return;
  cam.alpha -= dx * 0.01;
  cam.beta  -= dy * 0.01;
  cam.beta = Math.max(0.01, Math.min(Math.PI - 0.01, cam.beta));
}

function _wireCameraSync() {
  _scene ??= SceneManager.getScene();
  if (!_scene) return;
  _scene.onBeforeRenderObservable.add(() => {
    const cam = _scene.activeCamera;
    if (!cam || !_cube) return;
    // ArcRotateCamera spherical angles drive the cube directly. Verified live
    // against the scene at four poses (front = identity; orbit-left + above →
    // FRONT/LEFT/TOP; orbit-right + below → FRONT/RIGHT/BOTTOM): the cube
    // tracks the camera and every face label stays upright/readable with
    //   rotateX(β − π/2)  rotateY(π/2 − α)
    // At the front preset (α = β = π/2) this is the identity (bare FRONT
    // face). Yaw is π/2 − α (not α − π/2): viewed from FRONT in Babylon's
    // left-handed space, world +X is on the viewer's LEFT, so a camera on
    // +X (α = 0) must show the LEFT face. Reconstructing this from the view
    // matrix kept introducing mirror / 180° flips, so we use the camera's
    // own angles.
    const a = cam.alpha ?? Math.PI / 2;
    const b = cam.beta  ?? Math.PI / 2;
    const pitch = b - Math.PI / 2;
    const yaw   = Math.PI / 2 - a;
    _cube.style.transform = `rotateX(${pitch}rad) rotateY(${yaw}rad)`;
  });
}

export const NavCube = { init };
