/**
 * Camera moves of Support Mode (plan P3.5): Show on a finding, Fit view, Bottom view. The camera
 * is the app's ArcRotateCamera (CameraRig); the moves reuse its own animation helpers. Bottom view
 * also hides the bed grid and the floor disc (restored when it ends or the mode closes).
 */
import { SceneManager } from '../../core/SceneManager.js';
import { AssetLoader } from '../../core/AssetLoader.js';
import { logicalObjectPartIds } from '../../core/LogicalObjects.js';
import { getState } from '../../core/StateManager.js';
import { supportUi, type PanelProblem } from '../../panels/supports/supportUi';
import { supportMode } from '../SupportMode';
import { anchorOffset, supportToBabylon } from '../BabylonViewportPort';
import { leadPosition, objectModel } from '../objectModel';
import { appSupportLayers } from '../layers/index';

/* eslint-disable @typescript-eslint/no-explicit-any -- Babylon is the untyped window global here */
const BABYLON = (globalThis as any).BABYLON;

const FLOOR_MESHES = ['grid', 'mx-env-floor'];
let hidden: Array<{ mesh: any; visible: boolean }> = [];
let savedView: { alpha: number; beta: number; radius: number; target: any } | undefined;

function camera(): any {
  return SceneManager.getCamera();
}

function animate(camera: any, props: Record<string, any>, ms = 280): void {
  const frames = Math.max(1, Math.round(60 * (ms / 1000)));
  const ease = new BABYLON.QuadraticEase();
  ease.setEasingMode(BABYLON.EasingFunction.EASINGMODE_EASEINOUT);
  for (const [name, to] of Object.entries(props)) {
    BABYLON.Animation.CreateAndStartAnimation(`support_${name}`, camera, name, 60, frames, name === 'target' ? camera.target.clone() : camera[name], to, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT, ease);
  }
}

/** Babylon position of a support-frame point of `objectId`, or undefined without a model. */
export function problemPoint(objectId: string, point: readonly [number, number, number]): [number, number, number] | undefined {
  const om = objectModel(objectId);
  if (!om) return undefined;
  return supportToBabylon(point as [number, number, number], om.anchor, anchorOffset(om.anchor, leadPosition(objectId)));
}

/** Move the camera to a finding and ring it for a moment. */
export function showProblem(problem: PanelProblem): void {
  const target = problemPoint(problem.unitId, problem.position);
  const cam = camera();
  if (!target || !cam) return;
  const radius = Math.max(0.02, Math.min(cam.radius, 0.12));
  animate(cam, { target: new BABYLON.Vector3(target[0], target[1], target[2]), radius });
  void appSupportLayers().then((layers) => {
    layers.setRemoveRing(problem.unitId, { point: target, normal: [0, 1, 0], radiusMm: 2.5 });
    setTimeout(() => layers.setRemoveRing(problem.unitId, undefined), 2500);
  });
}

/** Frame every object of the mode. */
export function fitView(): void {
  const objects = getState().scene.objects;
  const meshes = supportMode.getObjectIds()
    .flatMap((id) => logicalObjectPartIds(id, objects))
    .flatMap((id: string) => (AssetLoader as any).getBabylonMesh?.(id) ?? []);
  SceneManager.frameSelected(meshes);
}

function floorMeshes(): any[] {
  const scene = SceneManager.getScene();
  return FLOOR_MESHES.flatMap((name) => scene?.getMeshByName?.(name) ?? []);
}

export function setBottomView(on: boolean): void {
  const cam = camera();
  if (!cam) return;
  if (on) {
    if (!savedView) savedView = { alpha: cam.alpha, beta: cam.beta, radius: cam.radius, target: cam.target.clone() };
    if (!hidden.length) hidden = floorMeshes().map((mesh) => ({ mesh, visible: mesh.isVisible }));
    for (const { mesh } of hidden) mesh.isVisible = false;
    animate(cam, { beta: Math.PI - 0.35 });
  } else {
    for (const { mesh, visible } of hidden) mesh.isVisible = visible;
    hidden = [];
    if (savedView) animate(cam, { beta: savedView.beta, alpha: savedView.alpha });
    savedView = undefined;
  }
  supportUi.set({ bottomView: on });
}

/** Leave Bottom view when the mode closes. */
export function resetCamera(): void {
  if (supportUi.get().bottomView || hidden.length) setBottomView(false);
}
