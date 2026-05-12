import { undo, redo } from './HistoryManager.js';
import { setCameraPreset } from './SceneManager.js';

const _handlers = new Map();  // `${key}::${context}` → fn
let _currentContext = 'global';
let _scene = null;

// ── Key string builder ───────────────────────────────────

function _buildKey(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey)  parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const isNumpad = e.code?.startsWith('Numpad');
  const key = isNumpad ? e.code : (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  parts.push(key);
  return parts.join('+');
}

function _isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

// ── Dispatcher ───────────────────────────────────────────

function _handleKeyDown(e) {
  if (_isTypingTarget(document.activeElement) && e.key !== 'Escape') return;
  const key = _buildKey(e);
  const fn  = _handlers.get(`${key}::${_currentContext}`) ?? _handlers.get(`${key}::global`);
  if (fn) { e.preventDefault(); fn(e); }
}

// ── Public API ───────────────────────────────────────────

/**
 * Initialise input handling against a Babylon scene.
 * @param {import('babylonjs').Scene} scene
 */
export function init(scene) {
  _scene = scene;
  _registerAll();
  document.addEventListener('keydown', _handleKeyDown);
  scene.onPointerObservable.add(_onPointer);

  const canvas = scene.getEngine().getRenderingCanvas();
  if (canvas) {
    canvas.addEventListener('focus', () => setContext('viewport'));
    canvas.addEventListener('blur',  () => setContext('global'));
  }
}

/**
 * Register a shortcut handler.
 * @param {string} shortcut  e.g. 'Ctrl+Z', 'G', 'Numpad1'
 * @param {'global'|'viewport'|'outliner'|'properties'} context
 * @param {function} callbackFn
 */
export function register(shortcut, context, callbackFn) {
  _handlers.set(`${shortcut}::${context}`, callbackFn);
}

/**
 * Unregister a shortcut.
 * @param {string} shortcut
 * @param {string} context
 */
export function unregister(shortcut, context) {
  _handlers.delete(`${shortcut}::${context}`);
}

/**
 * Set the active input context.
 * @param {'global'|'viewport'|'outliner'|'properties'} context
 */
export function setContext(context) {
  _currentContext = context;
}

// ── Pointer observable ───────────────────────────────────

function _onPointer() {
  // Selection and interaction wired in Phase 3
}

// ── Shortcut registrations ───────────────────────────────

const _noop = () => {};

function _registerAll() {
  // Global — history
  register('Ctrl+Z',       'global', () => undo());
  register('Ctrl+Shift+Z', 'global', () => redo());
  register('Ctrl+Y',       'global', () => redo());

  // Global — project (Phase 6)
  register('Ctrl+S',       'global', _noop);
  register('Ctrl+Shift+S', 'global', _noop);
  register('Ctrl+N',       'global', _noop);
  register('Ctrl+O',       'global', _noop);

  // Viewport — transforms (Phase 3)
  register('G',      'viewport', _noop);
  register('R',      'viewport', _noop);
  register('S',      'viewport', _noop);
  register('Escape', 'viewport', _noop);
  register('Enter',  'viewport', _noop);

  // Viewport — selection (Phase 3)
  register('A',     'viewport', _noop);
  register('Alt+A', 'viewport', _noop);
  register('B',     'viewport', _noop);

  // Viewport — framing (Phase 3)
  register('F', 'viewport', _noop);

  // Viewport — camera numpad
  register('Numpad0',      'viewport', () => setCameraPreset('perspective'));
  register('Numpad1',      'viewport', () => setCameraPreset('front'));
  register('Numpad3',      'viewport', () => setCameraPreset('right'));
  register('Numpad7',      'viewport', () => setCameraPreset('top'));
  register('Ctrl+Numpad1', 'viewport', () => setCameraPreset('back'));
  register('Ctrl+Numpad3', 'viewport', () => setCameraPreset('left'));
  register('Ctrl+Numpad7', 'viewport', () => setCameraPreset('bottom'));
  register('Numpad5',      'viewport', _toggleOrtho);
  register('Numpad4',      'viewport', () => _orbitCamera(-15,  0));
  register('Numpad6',      'viewport', () => _orbitCamera( 15,  0));
  register('Numpad8',      'viewport', () => _orbitCamera(  0, -15));
  register('Numpad2',      'viewport', () => _orbitCamera(  0,  15));

  // Laptop fallbacks for camera
  register('Alt+1',      'viewport', () => setCameraPreset('front'));
  register('Alt+3',      'viewport', () => setCameraPreset('right'));
  register('Alt+7',      'viewport', () => setCameraPreset('top'));
  register('Ctrl+Alt+1', 'viewport', () => setCameraPreset('back'));
  register('Ctrl+Alt+3', 'viewport', () => setCameraPreset('left'));
  register('Ctrl+Alt+7', 'viewport', () => setCameraPreset('bottom'));

  // Viewport — visibility / hierarchy (Phase 3)
  register('H',            'viewport', _noop);
  register('Alt+H',        'viewport', _noop);
  register('Ctrl+G',       'viewport', _noop);
  register('Ctrl+Shift+G', 'viewport', _noop);
  register('Shift+D',      'viewport', _noop);
  register('Delete',       'viewport', _noop);
  register('X',            'viewport', _noop);

  // Viewport — misc (Phase 3)
  register('Tab', 'viewport', _noop);
  register('~',   'viewport', _noop);
  register('.',   'viewport', _noop);
}

function _toggleOrtho() {
  if (!_scene?.activeCamera) return;
  const isPersp = _scene.activeCamera.mode === 0; // PERSPECTIVE_CAMERA
  setCameraPreset(isPersp ? 'front' : 'perspective');
}

function _orbitCamera(deltaDegH, deltaDegV) {
  if (!_scene?.activeCamera) return;
  const cam = _scene.activeCamera;
  cam.alpha += (deltaDegH * Math.PI) / 180;
  cam.beta  += (deltaDegV * Math.PI) / 180;
}

export const InputManager = { init, register, unregister, setContext };
