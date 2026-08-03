import { SceneManager } from '../core/SceneManager.js';
import { Selection } from '../core/Selection.js';
import { InputManager } from '../core/InputManager.js';
import { AssetLoader } from '../core/AssetLoader.js';
import { push, performSliceConnector } from '../core/HistoryManager.js';
import { computeBoolean } from '../core/BooleanService.js';
import {
  createSliceConnectorMeshes,
  mmToBU,
  planSliceConnector,
  worldBoundsForMesh,
} from '../core/SliceConnectorService.js';
import { safeAsync, Toast } from './Toast.js';
import { escapeHtml } from './renderSafe.js';
import { t } from '../i18n/index.js';

const B = window.BABYLON;
const DEFAULTS = Object.freeze({
  connectorShape: 'round',
  diameterMM: 6,
  depthMM: 8,
  clearanceMM: 0.2,
  maleSide: 'front',
});
const LINE_COLOR = new B.Color3(0.96, 0.62, 0.12);
const PEG_COLOR = new B.Color3(0.25, 0.72, 1);
const HALF_A_COLOR = new B.Color3(0.96, 0.62, 0.12);
const HALF_B_COLOR = new B.Color3(0.25, 0.72, 1);

let _session = null;

function _plain(v) {
  return v ? { x: v.x, y: v.y, z: v.z } : null;
}

function _v(p) {
  return new B.Vector3(p.x, p.y, p.z);
}

function _normalize(v) {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return new B.Vector3(v.x / len, v.y / len, v.z / len);
}

function _cameraNormal() {
  const camera = SceneManager.getCamera();
  return _normalize(camera?.getForwardRay?.().direction ?? new B.Vector3(0, 0, 1));
}

function _orientLocalYTo(mesh, dir) {
  const q = new B.Quaternion();
  B.Quaternion.FromUnitVectorsToRef(B.Vector3.Up(), _normalize(dir), q);
  mesh.rotationQuaternion = q;
}

function _boundsDiag(bounds) {
  return Math.hypot(
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z,
  );
}

function _makeMaterial(scene, name, color, alpha = 0.85) {
  const mat = new B.StandardMaterial(name, scene);
  mat.diffuseColor = color;
  mat.emissiveColor = color.scale(0.35);
  mat.alpha = alpha;
  mat.disableLighting = true;
  return mat;
}

function _rayToViewPlane(x, y) {
  const ray = _session.scene.createPickingRay(x, y, B.Matrix.Identity(), _session.scene.activeCamera);
  const denom = B.Vector3.Dot(ray.direction, _session.cameraNormal);
  if (Math.abs(denom) < 1e-6) return null;
  const dist = B.Vector3.Dot(_session.sourceCenter.subtract(ray.origin), _session.cameraNormal) / denom;
  if (dist < 0) return null;
  return ray.origin.add(ray.direction.scale(dist));
}

function _rayToCutPlane() {
  const ray = _session.scene.createPickingRay(_session.scene.pointerX, _session.scene.pointerY, B.Matrix.Identity(), _session.scene.activeCamera);
  const normal = _v(_session.plan.planeNormal);
  const center = _v(_session.plan.planeCenter);
  const denom = B.Vector3.Dot(ray.direction, normal);
  if (Math.abs(denom) < 1e-6) return null;
  const dist = B.Vector3.Dot(center.subtract(ray.origin), normal) / denom;
  if (dist < 0) return null;
  return ray.origin.add(ray.direction.scale(dist));
}

function _options() {
  return {
    cameraNormal: _plain(_session.cameraNormal),
    lineStart: _plain(_session.lineStartWorld),
    lineEnd: _plain(_session.lineEndWorld),
    connectorPoint: _plain(_session.connectorPoint ?? _session.sourceCenter),
    maleSide: _session.maleSide,
    connectorShape: _session.connectorShape,
    diameterMM: _session.diameterMM,
    depthMM: _session.depthMM,
    clearanceMM: _session.clearanceMM,
  };
}

function _plan() {
  const mesh = AssetLoader.getBabylonMesh(_session.meshId);
  if (!mesh || !_session.lineStartWorld || !_session.lineEndWorld) return null;
  _session.plan = planSliceConnector(worldBoundsForMesh(mesh), _options());
  return _session.plan;
}

function _setStep(step) {
  _session.step = step;
  if (step === 'place-origin') _focusCutFace();
  _renderPanel();
  _refreshVisibility();
  _updatePreview();
}

function _setSvgLine(start, end) {
  const line = _session.svgLine;
  if (!start || !end) {
    line.setAttribute('visibility', 'hidden');
    return;
  }
  line.setAttribute('visibility', 'visible');
  line.setAttribute('x1', String(start.x));
  line.setAttribute('y1', String(start.y));
  line.setAttribute('x2', String(end.x));
  line.setAttribute('y2', String(end.y));
}

function _setWorldLineFromScreen(start, end) {
  const a = _rayToViewPlane(start.x, start.y);
  const b = _rayToViewPlane(end.x, end.y);
  if (!a || !b || a.subtract(b).length() < 1e-5) return false;
  _session.lineStartScreen = start;
  _session.lineEndScreen = end;
  _session.lineStartWorld = a;
  _session.lineEndWorld = b;
  _setSvgLine(start, end);
  _plan();
  _updatePreview();
  return true;
}

function _disposeMeshes(list) {
  for (const mesh of list ?? []) {
    try { mesh?.dispose?.(); } catch { /* already disposed */ }
  }
}

function _isPreviewMesh(mesh) {
  return !!mesh && (
    mesh === _session?.halfA ||
    mesh === _session?.halfB ||
    mesh === _session?.worldLine ||
    mesh === _session?.pegPreview ||
    mesh === _session?.marker ||
    _session?.tempMeshes?.includes(mesh)
  );
}

function _setOtherContentHidden(hidden) {
  if (!_session?.scene) return;
  if (!hidden) {
    for (const [mesh, enabled] of _session.hiddenMeshes ?? []) {
      if (!mesh?.isDisposed?.()) mesh.setEnabled(enabled);
    }
    _session.hiddenMeshes?.clear?.();
    return;
  }
  if (!_session.hiddenMeshes) _session.hiddenMeshes = new Map();
  for (const mesh of _session.scene.meshes) {
    if (!mesh || _isPreviewMesh(mesh)) continue;
    const id = mesh.metadata?.meshId;
    if (!id || id === _session.meshId) continue;
    if (!_session.hiddenMeshes.has(mesh)) _session.hiddenMeshes.set(mesh, mesh.isEnabled());
    mesh.setEnabled(false);
  }
}

function _focusCutFace() {
  const plan = _session?.plan;
  const camera = SceneManager.getCamera();
  if (!plan || !camera || _session.didFocusCutFace) return;
  const center = _v(plan.connectorPoint ?? plan.planeCenter);
  const normal = _v(plan.planeNormal);
  const sign = _session.maleSide === 'front' ? 1 : -1;
  const radius = Math.max(_session.extent * 1.4, camera.radius ?? 0.08, 0.08);
  camera.target.copyFrom(center);
  camera.setPosition(center.add(normal.scale(sign * radius)));
  _session.didFocusCutFace = true;
}

async function _buildTemporaryCut() {
  const mesh = AssetLoader.getBabylonMesh(_session.meshId);
  const plan = _plan();
  if (!mesh || !plan) return false;
  _disposeMeshes(_session.tempMeshes);
  const furniture = createSliceConnectorMeshes(B, _session.scene, plan, `slice_preview_${_session.meshId}`);
  const halfA = await computeBoolean('intersect', [mesh, furniture.positiveCutter], { name: 'slice_preview_A' });
  const halfB = await computeBoolean('intersect', [mesh, furniture.negativeCutter], { name: 'slice_preview_B' });
  const matA = _makeMaterial(_session.scene, 'slicePreviewA', HALF_A_COLOR, 0.8);
  const matB = _makeMaterial(_session.scene, 'slicePreviewB', HALF_B_COLOR, 0.8);
  halfA.material = matA;
  halfB.material = matB;
  halfA.metadata = { sliceConnectorFurniture: true, slicePreviewSide: 'front' };
  halfB.metadata = { sliceConnectorFurniture: true, slicePreviewSide: 'back' };
  halfA.isPickable = false;
  halfB.isPickable = false;
  _session.sourceMesh.setEnabled(false);
  _session.tempMeshes = [halfA, halfB, matA, matB, ...Object.values(furniture)];
  _session.halfA = halfA;
  _session.halfB = halfB;
  _setStep('choose-male');
  return true;
}

function _refreshVisibility() {
  if (!_session?.halfA || !_session?.halfB) return;
  const isolateMale = _session.step === 'place-origin' || _session.step === 'size' || _session.step === 'depth';
  _setOtherContentHidden(isolateMale);
  if (_session.step === 'draw-line') {
    _session.halfA.setEnabled(false);
    _session.halfB.setEnabled(false);
    _session.sourceMesh.setEnabled(true);
    return;
  }
  _session.sourceMesh.setEnabled(false);
  if (_session.step === 'choose-male' || _session.step === 'clearance' || _session.step === 'finish') {
    _session.halfA.setEnabled(true);
    _session.halfB.setEnabled(true);
    return;
  }
  _session.halfA.setEnabled(_session.maleSide === 'front');
  _session.halfB.setEnabled(_session.maleSide === 'back');
}

function _makePegPreviewPrimitive() {
  _disposeMeshes([_session.pegPreview, _session.pegMat, _session.marker]);
  const plan = _plan();
  if (!plan || !_session.connectorPoint) return;
  _session.pegMat = _makeMaterial(_session.scene, 'sliceConnectorPegMat', PEG_COLOR, 0.72);
  const diameter = mmToBU(_session.diameterMM);
  if (_session.connectorShape === 'square') {
    _session.pegPreview = B.MeshBuilder.CreateBox('sliceConnectorSquarePreview', {
      width: diameter,
      depth: diameter,
      height: mmToBU(_session.depthMM),
    }, _session.scene);
  } else {
    _session.pegPreview = B.MeshBuilder.CreateCylinder('sliceConnectorRoundPreview', {
      diameter,
      height: mmToBU(_session.depthMM),
      tessellation: 32,
    }, _session.scene);
  }
  _session.marker = B.MeshBuilder.CreateSphere('sliceConnectorOriginPreview', { diameter: diameter * 1.2 }, _session.scene);
  _session.pegPreview.material = _session.pegMat;
  _session.marker.material = _session.pegMat;
  _session.pegPreview.isPickable = false;
  _session.marker.isPickable = false;
  _session.pegPreview.renderingGroupId = 2;
  _session.marker.renderingGroupId = 2;
}

function _updatePreview() {
  const plan = _plan();
  if (!plan) return;
  if (_session.worldLine) _session.worldLine.dispose();
  _session.worldLine = B.MeshBuilder.CreateLines('sliceConnectorWorldLine', {
    points: [_session.lineStartWorld, _session.lineEndWorld],
  }, _session.scene);
  _session.worldLine.color = LINE_COLOR;
  _session.worldLine.isPickable = false;
  _session.worldLine.renderingGroupId = 2;
  if (_session.connectorPoint) {
    _makePegPreviewPrimitive();
    _session.pegPreview.position.copyFrom(_v(plan.connectorCenter));
    _orientLocalYTo(_session.pegPreview, _v(plan.pegDirection));
    _session.marker.position.copyFrom(_v(plan.connectorPoint));
  }
}

function _panelButton(action, label, cls = '') {
  return `<button type="button" class="${escapeHtml(cls)}" data-action="${escapeHtml(action)}">${escapeHtml(label)}</button>`;
}

function _renderPanel() {
  const s = _session;
  const step = s.step;
  const canCut = !!(s.lineStartWorld && s.lineEndWorld);
  const body = step === 'draw-line' ? `
      <p>${escapeHtml(t('sliceConnector.hintDrawLine'))}</p>
      <div class="slice-tool-row">
        ${_panelButton('cut', t('sliceConnector.cut'), canCut ? 'btn-primary' : '')}
      </div>`
    : step === 'choose-male' ? `
      <p>${escapeHtml(t('sliceConnector.hintChooseMale'))}</p>
      <div class="slice-tool-row">
        ${_panelButton('male-front', t('sliceConnector.partA'), s.maleSide === 'front' ? 'btn-primary' : '')}
        ${_panelButton('male-back', t('sliceConnector.partB'), s.maleSide === 'back' ? 'btn-primary' : '')}
      </div>
      <div class="slice-tool-row">${_panelButton('next-place', t('sliceConnector.next'), 'btn-primary')}</div>`
    : step === 'place-origin' ? `
      <p>${escapeHtml(t('sliceConnector.hintPlace'))}</p>
      <div class="slice-tool-row">${_panelButton('next-size', t('sliceConnector.next'), s.connectorPoint ? 'btn-primary' : '')}</div>`
    : step === 'size' ? `
      <p>${escapeHtml(t('sliceConnector.hintSize'))}</p>
      <label>${escapeHtml(t('sliceConnector.shape'))}
        <select data-field="connectorShape">
          <option value="round"${s.connectorShape === 'round' ? ' selected' : ''}>${escapeHtml(t('sliceConnector.shapeRound'))}</option>
          <option value="square"${s.connectorShape === 'square' ? ' selected' : ''}>${escapeHtml(t('sliceConnector.shapeSquare'))}</option>
        </select>
      </label>
      <label>${escapeHtml(t('sliceConnector.diameter'))}<input type="number" data-field="diameterMM" min="0.1" step="0.1" value="${s.diameterMM}"></label>
      <div class="slice-tool-row">${_panelButton('next-depth', t('sliceConnector.next'), 'btn-primary')}</div>`
    : step === 'depth' ? `
      <p>${escapeHtml(t('sliceConnector.hintDepth'))}</p>
      <label>${escapeHtml(t('sliceConnector.depth'))}<input type="number" data-field="depthMM" min="0.1" step="0.1" value="${s.depthMM}"></label>
      <div class="slice-tool-row">${_panelButton('next-clearance', t('sliceConnector.next'), 'btn-primary')}</div>`
    : `
      <p>${escapeHtml(t('sliceConnector.hintClearance'))}</p>
      <label>${escapeHtml(t('sliceConnector.clearance'))}<input type="number" data-field="clearanceMM" min="0" step="0.05" value="${s.clearanceMM}"></label>
      <div class="slice-tool-row">${_panelButton('finish', t('sliceConnector.finish'), 'btn-primary')}</div>`;
  s.panelEl.innerHTML = `
    <header>
      <strong>${escapeHtml(t('sliceConnector.title'))}</strong>
      <button type="button" data-action="cancel" aria-label="${escapeHtml(t('sliceConnector.cancel'))}">×</button>
    </header>
    <div class="slice-tool-progress">${escapeHtml(_progressLabel(step))}</div>
    <div class="slice-tool-body">${body}</div>
    <footer>
      ${step === 'draw-line' ? '' : _panelButton('back', t('sliceConnector.back'))}
      ${_panelButton('cancel', t('sliceConnector.cancel'))}
    </footer>`;
}

function _progressLabel(step) {
  const order = ['draw-line', 'choose-male', 'place-origin', 'size', 'depth', 'clearance'];
  return `${order.indexOf(step) + 1}/${order.length}`;
}

function _readPanelFields() {
  const shape = _session.panelEl.querySelector('[data-field="connectorShape"]')?.value;
  if (shape === 'round' || shape === 'square') _session.connectorShape = shape;
  for (const key of ['diameterMM', 'depthMM', 'clearanceMM']) {
    const value = Number(_session.panelEl.querySelector(`[data-field="${key}"]`)?.value);
    if (Number.isFinite(value) && value >= 0) _session[key] = value;
  }
  _updatePreview();
}

function _wirePanel() {
  _session.panelEl.addEventListener('input', _readPanelFields);
  _session.panelEl.addEventListener('change', _readPanelFields);
  _session.panelEl.addEventListener('click', (e) => {
    const action = e.target?.dataset?.action;
    if (!action) return;
    if (action === 'cancel') stop();
    if (action === 'back') _back();
    if (action === 'cut' && _session.lineStartWorld) safeAsync(_buildTemporaryCut);
    if (action === 'male-front') { _session.maleSide = 'front'; _renderPanel(); _refreshVisibility(); _updatePreview(); }
    if (action === 'male-back') { _session.maleSide = 'back'; _renderPanel(); _refreshVisibility(); _updatePreview(); }
    if (action === 'next-place') _setStep('place-origin');
    if (action === 'next-size' && _session.connectorPoint) _setStep('size');
    if (action === 'next-depth') _setStep('depth');
    if (action === 'next-clearance') _setStep('clearance');
    if (action === 'finish') safeAsync(_finish);
  });
}

function _back() {
  const order = ['draw-line', 'choose-male', 'place-origin', 'size', 'depth', 'clearance'];
  const idx = order.indexOf(_session.step);
  if (idx <= 0) return;
  if (order[idx - 1] === 'draw-line') {
    _disposeMeshes(_session.tempMeshes);
    _session.tempMeshes = [];
    _session.halfA = null;
    _session.halfB = null;
    _session.sourceMesh.setEnabled(true);
  }
  _setStep(order[idx - 1]);
}

function _handleDrawPointer(info) {
  const ev = info.event;
  if (info.type === B.PointerEventTypes.POINTERDOWN && ev.button === 0) {
    _session.draw = { start: { x: _session.scene.pointerX, y: _session.scene.pointerY } };
    _setSvgLine(_session.draw.start, _session.draw.start);
    return true;
  }
  if (info.type === B.PointerEventTypes.POINTERMOVE && _session.draw) {
    _setSvgLine(_session.draw.start, { x: _session.scene.pointerX, y: _session.scene.pointerY });
    return true;
  }
  if (info.type === B.PointerEventTypes.POINTERUP && ev.button === 0 && _session.draw) {
    const start = _session.draw.start;
    const end = { x: _session.scene.pointerX, y: _session.scene.pointerY };
    _session.draw = null;
    _setWorldLineFromScreen(start, end);
    _renderPanel();
    return true;
  }
  return true;
}

function _handlePointer(info) {
  if (!_session) return false;
  const ev = info.event;
  if (info.type === B.PointerEventTypes.POINTERDOWN && ev.button === 2) {
    stop();
    return true;
  }
  if (_session.step === 'draw-line') return _handleDrawPointer(info);
  if (_session.step === 'place-origin' && info.type === B.PointerEventTypes.POINTERDOWN && ev.button === 0) {
    const point = _rayToCutPlane();
    if (point) {
      _session.connectorPoint = point;
      _updatePreview();
      _renderPanel();
    }
    return true;
  }
  if (_session.step === 'size') return _handleSizePointer(info);
  if (_session.step === 'depth') return _handleDepthPointer(info);
  return true;
}

function _handleSizePointer(info) {
  const ev = info.event;
  if (info.type === B.PointerEventTypes.POINTERDOWN && ev.button === 0) {
    _session.sizeDrag = true;
    return true;
  }
  if (info.type === B.PointerEventTypes.POINTERMOVE && _session.sizeDrag) {
    const point = _rayToCutPlane();
    if (point && _session.connectorPoint) {
      _session.diameterMM = Math.max(0.5, point.subtract(_session.connectorPoint).length() * 2000);
      _renderPanel();
      _updatePreview();
    }
    return true;
  }
  if (info.type === B.PointerEventTypes.POINTERUP && ev.button === 0) {
    _session.sizeDrag = false;
    return true;
  }
  return true;
}

function _handleDepthPointer(info) {
  const ev = info.event;
  if (info.type === B.PointerEventTypes.POINTERDOWN && ev.button === 0) {
    _session.depthDrag = { y: _session.scene.pointerY, depthMM: _session.depthMM };
    return true;
  }
  if (info.type === B.PointerEventTypes.POINTERMOVE && _session.depthDrag) {
    const dy = _session.scene.pointerY - _session.depthDrag.y;
    _session.depthMM = Math.max(0.5, _session.depthDrag.depthMM - dy * 0.15);
    _renderPanel();
    _updatePreview();
    return true;
  }
  if (info.type === B.PointerEventTypes.POINTERUP && ev.button === 0) {
    _session.depthDrag = null;
    return true;
  }
  return true;
}

async function _finish() {
  const options = _options();
  const meshId = _session.meshId;
  stop({ keepSourceHidden: false });
  const command = await performSliceConnector(meshId, options);
  if (command?.blocked) {
    const key = command.reason === 'multi-part' ? 'toast.sliceConnectorMultiPart'
      : command.reason === 'too-large' ? 'toast.sliceConnectorTooLarge'
      : command.reason === 'needs-texture-bake' ? 'toast.sliceConnectorTextured'
      : 'toast.sliceConnectorBlocked';
    Toast.show(t(key, { reason: command.reason }), 'warning', 4000);
    return;
  }
  push(command);
}

function _buildOverlay(viewport) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('slice-tool-line-overlay');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.classList.add('slice-tool-cut-line');
  line.setAttribute('visibility', 'hidden');
  svg.appendChild(line);
  viewport.appendChild(svg);
  return { svg, line };
}

export function start() {
  stop();
  const meshId = Selection.getActiveId();
  const sourceMesh = meshId && AssetLoader.getBabylonMesh(meshId);
  if (!meshId || !sourceMesh) {
    Toast.show(t('toast.sliceConnectorSelectOne'), 'warning', 3000);
    return;
  }
  sourceMesh.computeWorldMatrix(true);
  const scene = SceneManager.getScene();
  const viewport = document.getElementById('viewport') ?? document.body;
  const bounds = worldBoundsForMesh(sourceMesh);
  const panelEl = document.createElement('section');
  panelEl.className = 'slice-tool-panel';
  viewport.appendChild(panelEl);
  const overlay = _buildOverlay(viewport);
  _session = {
    meshId,
    sourceMesh,
    scene,
    viewport,
    cameraNormal: _cameraNormal(),
    sourceCenter: sourceMesh.getBoundingInfo().boundingBox.centerWorld.clone(),
    extent: Math.max(_boundsDiag(bounds) * 1.35, 0.04),
    step: 'draw-line',
    maleSide: DEFAULTS.maleSide,
    connectorShape: DEFAULTS.connectorShape,
    diameterMM: DEFAULTS.diameterMM,
    depthMM: DEFAULTS.depthMM,
    clearanceMM: DEFAULTS.clearanceMM,
    connectorPoint: null,
    lineStartScreen: null,
    lineEndScreen: null,
    lineStartWorld: null,
    lineEndWorld: null,
    plan: null,
    tempMeshes: [],
    panelEl,
    svgEl: overlay.svg,
    svgLine: overlay.line,
    hiddenMeshes: new Map(),
    didFocusCutFace: false,
  };
  _wirePanel();
  _renderPanel();
  InputManager.setViewportToolHandler(_handlePointer);
}

export function stop(options = {}) {
  if (!_session) return;
  InputManager.setViewportToolHandler(null);
  _disposeMeshes([
    ...(_session.tempMeshes ?? []),
    _session.worldLine,
    _session.pegPreview,
    _session.pegMat,
    _session.marker,
  ]);
  if (!options.keepSourceHidden) _session.sourceMesh?.setEnabled(true);
  _setOtherContentHidden(false);
  _session.panelEl?.remove?.();
  _session.svgEl?.remove?.();
  _session = null;
}

export const SliceConnectorSession = { start, stop };
