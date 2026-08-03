import { SceneManager } from '../core/SceneManager.js';
import { Selection } from '../core/Selection.js';
import { InputManager } from '../core/InputManager.js';
import { AssetLoader } from '../core/AssetLoader.js';
import { push, performSliceConnector } from '../core/HistoryManager.js';
import { planSliceConnector, worldBoundsForMesh, mmToBU } from '../core/SliceConnectorService.js';
import { safeAsync, Toast } from './Toast.js';
import { escapeHtml } from './renderSafe.js';
import { t } from '../i18n/index.js';

const B = window.BABYLON;
const DEFAULTS = Object.freeze({
  diameterMM: 6,
  depthMM: 8,
  clearanceMM: 0.2,
  maleSide: 'front',
});
const PLANE_ALPHA = 0.22;
const LINE_COLOR = new B.Color3(0.96, 0.62, 0.12);
const PEG_COLOR = new B.Color3(0.25, 0.72, 1);

let _session = null;

function _v(p) {
  return new B.Vector3(p.x, p.y, p.z);
}

function _plain(v) {
  return { x: v.x, y: v.y, z: v.z };
}

function _normalize(v) {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return new B.Vector3(v.x / len, v.y / len, v.z / len);
}

function _orientLocalZTo(mesh, dir) {
  const q = new B.Quaternion();
  B.Quaternion.FromUnitVectorsToRef(B.Vector3.Forward(), _normalize(dir), q);
  mesh.rotationQuaternion = q;
}

function _orientLocalYTo(mesh, dir) {
  const q = new B.Quaternion();
  B.Quaternion.FromUnitVectorsToRef(B.Vector3.Up(), _normalize(dir), q);
  mesh.rotationQuaternion = q;
}

function _cameraNormal() {
  const camera = SceneManager.getCamera();
  const ray = camera?.getForwardRay?.();
  return _normalize(ray?.direction ?? new B.Vector3(0, 0, 1));
}

function _boundsDiag(bounds) {
  return Math.hypot(
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z,
  );
}

function _tangentFor(normal) {
  const up = Math.abs(normal.y) > 0.92 ? new B.Vector3(1, 0, 0) : B.Vector3.Up();
  return _normalize(B.Vector3.Cross(up, normal));
}

function _rayPlanePoint(scene, center, normal) {
  const ray = scene.createPickingRay(scene.pointerX, scene.pointerY, B.Matrix.Identity(), scene.activeCamera);
  const denom = B.Vector3.Dot(ray.direction, normal);
  if (Math.abs(denom) < 1e-6) return null;
  const dist = B.Vector3.Dot(center.subtract(ray.origin), normal) / denom;
  if (dist < 0) return null;
  return ray.origin.add(ray.direction.scale(dist));
}

function _number(root, name, fallback) {
  const input = root.querySelector(`[data-field="${name}"]`);
  const n = Number(input?.value);
  return Number.isFinite(n) ? n : fallback;
}

function _side(root) {
  const value = root.querySelector('[data-field="maleSide"]')?.value;
  return value === 'back' ? 'back' : 'front';
}

function _setHint(text) {
  if (_session?.hintEl) _session.hintEl.textContent = text;
}

function _readOptions() {
  const root = _session.panelEl;
  return {
    cameraNormal: _plain(_session.normal),
    planeOffsetMM: _session.offsetMM,
    connectorPoint: _plain(_session.connectorPoint ?? _session.planeCenter),
    maleSide: _side(root),
    diameterMM: _number(root, 'diameterMM', DEFAULTS.diameterMM),
    depthMM: _number(root, 'depthMM', DEFAULTS.depthMM),
    clearanceMM: _number(root, 'clearanceMM', DEFAULTS.clearanceMM),
  };
}

function _rebuildPlan() {
  const mesh = AssetLoader.getBabylonMesh(_session.meshId);
  if (!mesh) return null;
  const plan = planSliceConnector(worldBoundsForMesh(mesh), _readOptions());
  _session.planeCenter = _v(plan.planeCenter);
  _session.plan = plan;
  return plan;
}

function _updatePreview() {
  const plan = _rebuildPlan();
  if (!plan) return;
  const center = _v(plan.planeCenter);
  const normal = _v(plan.planeNormal);
  const tangent = _tangentFor(normal);
  const extent = Math.max(_session.extent, 0.04);

  _session.plane.position.copyFrom(center);
  _orientLocalZTo(_session.plane, normal);
  _session.plane.scaling.set(extent, extent, 1);

  _session.line.dispose();
  _session.line = B.MeshBuilder.CreateLines('sliceConnectorLine', {
    points: [
      center.subtract(tangent.scale(extent / 2)),
      center.add(tangent.scale(extent / 2)),
    ],
  }, _session.scene);
  _session.line.color = LINE_COLOR;
  _session.line.isPickable = false;
  _session.line.renderingGroupId = 2;

  const connectorPoint = _v(plan.connectorPoint);
  _session.peg.position.copyFrom(_v(plan.connectorCenter));
  _orientLocalYTo(_session.peg, _v(plan.pegDirection));
  _session.peg.scaling.setAll(1);
  _session.peg.isVisible = !!_session.connectorPoint;

  _session.marker.position.copyFrom(connectorPoint);
  _session.marker.isVisible = !!_session.connectorPoint;
}

function _makeMaterial(scene, name, color, alpha) {
  const mat = new B.StandardMaterial(name, scene);
  mat.diffuseColor = color;
  mat.emissiveColor = color.scale(0.5);
  mat.alpha = alpha;
  mat.disableLighting = true;
  return mat;
}

function _buildPanel() {
  const el = document.createElement('section');
  el.className = 'slice-tool-panel';
  el.innerHTML = `
    <header>
      <strong>${escapeHtml(t('sliceConnector.title'))}</strong>
      <button type="button" data-action="cancel" aria-label="${escapeHtml(t('sliceConnector.cancel'))}">×</button>
    </header>
    <p class="slice-tool-hint" data-role="hint">${escapeHtml(t('sliceConnector.hintMove'))}</p>
    <div class="slice-tool-row">
      <button type="button" data-action="move">${escapeHtml(t('sliceConnector.movePlane'))}</button>
      <button type="button" data-action="place">${escapeHtml(t('sliceConnector.placeConnector'))}</button>
    </div>
    <label>${escapeHtml(t('sliceConnector.maleSide'))}
      <select data-field="maleSide">
        <option value="front">${escapeHtml(t('sliceConnector.frontSide'))}</option>
        <option value="back">${escapeHtml(t('sliceConnector.backSide'))}</option>
      </select>
    </label>
    <label>${escapeHtml(t('sliceConnector.diameter'))}
      <input type="number" data-field="diameterMM" value="${DEFAULTS.diameterMM}" min="0.1" step="0.1">
    </label>
    <label>${escapeHtml(t('sliceConnector.depth'))}
      <input type="number" data-field="depthMM" value="${DEFAULTS.depthMM}" min="0.1" step="0.1">
    </label>
    <label>${escapeHtml(t('sliceConnector.clearance'))}
      <input type="number" data-field="clearanceMM" value="${DEFAULTS.clearanceMM}" min="0" step="0.05">
    </label>
    <footer>
      <button type="button" data-action="cancel">${escapeHtml(t('sliceConnector.cancel'))}</button>
      <button type="button" class="btn-primary" data-action="apply">${escapeHtml(t('sliceConnector.apply'))}</button>
    </footer>`;
  el.addEventListener('input', _updatePreview);
  el.addEventListener('change', _updatePreview);
  el.addEventListener('click', (e) => {
    const action = e.target?.dataset?.action;
    if (action === 'move') {
      _session.mode = 'move';
      _setHint(t('sliceConnector.hintMove'));
    }
    if (action === 'place') {
      _session.mode = 'place';
      _setHint(t('sliceConnector.hintPlace'));
    }
    if (action === 'cancel') stop();
    if (action === 'apply') safeAsync(_apply);
  });
  return el;
}

function _handlePointer(info) {
  if (!_session) return false;
  const ev = info.event;
  if (info.type === B.PointerEventTypes.POINTERDOWN && ev.button === 0) {
    if (_session.mode === 'place') {
      const point = _rayPlanePoint(_session.scene, _session.planeCenter, _session.normal);
      if (point) {
        _session.connectorPoint = point;
        _setHint(t('sliceConnector.hintReady'));
        _updatePreview();
      }
      return true;
    }
    _session.drag = { y: _session.scene.pointerY, offsetMM: _session.offsetMM };
    return true;
  }
  if (info.type === B.PointerEventTypes.POINTERMOVE && _session.drag) {
    const dy = _session.scene.pointerY - _session.drag.y;
    _session.offsetMM = _session.drag.offsetMM - dy * 0.35;
    _updatePreview();
    return true;
  }
  if (info.type === B.PointerEventTypes.POINTERUP && ev.button === 0) {
    _session.drag = null;
    return true;
  }
  if (info.type === B.PointerEventTypes.POINTERDOWN && ev.button === 2) {
    stop();
    return true;
  }
  return true;
}

async function _apply() {
  if (!_session) return;
  if (!_session.connectorPoint) {
    Toast.show(t('toast.sliceConnectorNeedsPoint'), 'warning', 3000);
    _session.mode = 'place';
    _setHint(t('sliceConnector.hintPlace'));
    return;
  }
  const meshId = _session.meshId;
  const options = _readOptions();
  stop();
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

export function start() {
  stop();
  const meshId = Selection.getActiveId();
  const mesh = meshId && AssetLoader.getBabylonMesh(meshId);
  if (!meshId || !mesh) {
    Toast.show(t('toast.sliceConnectorSelectOne'), 'warning', 3000);
    return;
  }
  const scene = SceneManager.getScene();
  const viewport = document.getElementById('viewport') ?? document.body;
  const bounds = worldBoundsForMesh(mesh);
  const extent = Math.max(_boundsDiag(bounds) * 1.35, 0.04);
  const normal = _cameraNormal();

  const planeMat = _makeMaterial(scene, 'sliceConnectorPlaneMat', LINE_COLOR, PLANE_ALPHA);
  const pegMat = _makeMaterial(scene, 'sliceConnectorPegMat', PEG_COLOR, 0.72);
  const plane = B.MeshBuilder.CreatePlane('sliceConnectorPlane', { size: 1 }, scene);
  plane.material = planeMat;
  plane.isPickable = false;
  plane.renderingGroupId = 2;

  const line = B.MeshBuilder.CreateLines('sliceConnectorLine', { points: [B.Vector3.Zero(), B.Vector3.Right()] }, scene);
  line.color = LINE_COLOR;
  line.isPickable = false;
  line.renderingGroupId = 2;

  const peg = B.MeshBuilder.CreateCylinder('sliceConnectorPegPreview', {
    diameter: mmToBU(DEFAULTS.diameterMM),
    height: mmToBU(DEFAULTS.depthMM),
    tessellation: 32,
  }, scene);
  peg.material = pegMat;
  peg.isPickable = false;
  peg.isVisible = false;
  peg.renderingGroupId = 2;

  const marker = B.MeshBuilder.CreateSphere('sliceConnectorMarker', { diameter: mmToBU(DEFAULTS.diameterMM) * 1.15 }, scene);
  marker.material = pegMat;
  marker.isPickable = false;
  marker.isVisible = false;
  marker.renderingGroupId = 2;

  const panelEl = _buildPanel();
  viewport.appendChild(panelEl);

  _session = {
    meshId,
    scene,
    normal,
    offsetMM: 0,
    connectorPoint: null,
    planeCenter: mesh.getBoundingInfo().boundingBox.centerWorld.clone(),
    extent,
    mode: 'move',
    drag: null,
    plane,
    line,
    peg,
    marker,
    planeMat,
    pegMat,
    panelEl,
    hintEl: panelEl.querySelector('[data-role="hint"]'),
  };
  InputManager.setViewportToolHandler(_handlePointer);
  _updatePreview();
}

export function stop() {
  if (!_session) return;
  InputManager.setViewportToolHandler(null);
  for (const item of [_session.plane, _session.line, _session.peg, _session.marker, _session.planeMat, _session.pegMat]) {
    try { item?.dispose?.(); } catch { /* already disposed */ }
  }
  _session.panelEl?.remove?.();
  _session = null;
}

export const SliceConnectorSession = { start, stop };
