/**
 * Support generation spike (plan 2026-10-29 P2.1). Dev-only trigger, no user UI:
 *
 *   await window.__mxSupportSpike()            // active (or first selected) logical object, MIDDLE
 *   await window.__mxSupportSpike({ preset: 'LIGHT', objectId })
 *
 * One selected logical object -> frame.ts (engine frame, welded copy) -> automatic placement (main
 * thread, generic) -> mesh worker `generate` (preview) -> drawn by the support layers
 * (`layers/`, P3.3; D20 through `layers/supportLayerTag.js`).
 */
import { configureGeometry, geometryReady } from '@mixo-geocore/host/workers/geometryClient';
import { placeGeneric } from '@mixo-geocore/host/supports/genericPlacement';
import { SupportMeshClient } from '@mixo-geocore/host/workers/meshClient';
import { encodeStl } from '@mixo-geocore/host/supports/export';
import { toPlacementSettings, type LiveSupportSettings, type PresetName } from '@mixo-geocore/host/core/supports/settings';
import type { GeneratedSupportMesh } from '@mixo-geocore/host/core/supports/mesh';
import workerUrl from '../support-engine/meshWorker.entry.ts?worker&url';
import { geometryGlueUrl, meshWorkerUrl } from '../support-engine/loadGeometry.js';
import { getState } from '../core/StateManager.js';
import { Selection } from '../core/Selection.js';
import { canonicalObjectId } from '../core/LogicalObjects.js';
import { signedVolume } from '../core/print/PrintSpace.js';
import { encodeBinarySTL } from '../core/print/StlWriter.js';
import { ENGINE_MM_PER_BU } from './frame';
import { presetSettings, supportJob, supportsToWorld, tipCount } from './supportJob';
import { objectModel } from './objectModel';
import { appSupportLayers, type SupportLayers } from './layers/index';

/* eslint-disable @typescript-eslint/no-explicit-any -- Babylon is the untyped window global here */
const BABYLON = (window as any).BABYLON;

export interface SpikeOptions {
  objectId?: string;
  preset?: PresetName;
  settings?: Partial<LiveSupportSettings>;
}

export interface SpikeResult {
  /** engine_version() reported by the WASM engine loaded in the main thread (the worker's is asserted on load). */
  engineVersion: number;
  objectId: string;
  parts: number;
  sourceVertices: number;
  engineVertices: number;
  engineTriangles: number;
  /** Signed volume of the engine-frame model, mm^3 (positive = outward). */
  modelVolumeMm3: number;
  placement: Record<string, number>;
  points: number;
  tips: number;
  dropped: number;
  supportTriangles: number;
  /** Signed volume of the engine-frame support mesh, mm^3. */
  supportVolumeMm3: number;
  verdict: string;
  ms: { placement: number; generate: number };
}

let client: SupportMeshClient | undefined;
const lastBuild = new Map<string, GeneratedSupportMesh>();
/** The layers the spike drew into (set by the first run; the tools below are synchronous for the screenshot script). */
let layers: SupportLayers | undefined;

function meshClient(): SupportMeshClient {
  client ??= new SupportMeshClient({
    create: typeof Worker === 'undefined' ? null
      : () => new Worker(meshWorkerUrl(new URL(workerUrl, document.baseURI), document.baseURI), { type: 'module' }) as any,
  });
  return client;
}

export async function runSupportSpike(options: SpikeOptions = {}): Promise<SpikeResult> {
  const objects = getState().scene.objects;
  const picked = options.objectId ?? Selection.getActiveId() ?? Selection.getSelectedIds()[0];
  if (!picked) throw new Error('support spike: select an object first');
  const objectId = canonicalObjectId(picked, objects);
  const object = objectModel(objectId);
  if (!object) throw new Error(`support spike: ${objectId} has no geometry`);

  configureGeometry(geometryGlueUrl(document.baseURI));
  const engine = await geometryReady();
  const settings = { ...presetSettings(options.preset ?? 'MIDDLE'), ...options.settings };
  const engineModel = object.engine;
  const model = object.model;
  const t0 = performance.now();
  const placement = placeGeneric(model.local, toPlacementSettings(settings));
  const t1 = performance.now();
  const built = await meshClient().build(objectId, supportJob(model, settings, placement), { key: 'Support building' });
  const t2 = performance.now();
  if (!built) throw new Error('support spike: build was replaced');
  const world = supportsToWorld(built, model.center);
  lastBuild.set(objectId, world);
  layers = await appSupportLayers();
  layers.setSupports(objectId, built, object.anchor);
  return {
    engineVersion: engine.engine_version(),
    objectId,
    parts: object.parts,
    sourceVertices: engineModel.sourceVertices,
    engineVertices: engineModel.mesh.positions.length / 3,
    engineTriangles: engineModel.mesh.indices.length / 3,
    modelVolumeMm3: signedVolume(engineModel.mesh.positions, engineModel.mesh.indices),
    placement: placement.points.reduce<Record<string, number>>((acc, p) => ((acc[p.source] = (acc[p.source] ?? 0) + 1), acc), {}),
    points: placement.points.length,
    tips: tipCount(built),
    dropped: built.dropped.length,
    supportTriangles: built.indices.length / 3,
    supportVolumeMm3: signedVolume(world.positions, world.indices),
    verdict: built.verdict?.status ?? 'none',
    ms: { placement: Math.round(t1 - t0), generate: Math.round(t2 - t1) },
  };
}

/** Proof helpers: the last build as STL in the engine frame and through the mixomesh export seam. */
function stlFiles(objectId: string) {
  const world = lastBuild.get(objectId);
  const mesh = layers?.supportLayer(objectId)?.mesh;
  if (!world || !mesh) throw new Error(`support spike: nothing built for ${objectId}`);
  const engine = new Uint8Array(encodeStl([{ mesh: world, transform: { position: [0, 0, 0], rotation: [0, 0, 0] } }]));
  // Export frame: the drawn Babylon mesh, mm-baked as PrintPrep does, through PrintSpace (StlWriter).
  const raw = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind) as Float32Array;
  const mm = Float32Array.from(raw, (v) => v * ENGINE_MM_PER_BU);
  const proxy = { name: mesh.name, material: mesh.material, sideOrientation: mesh.sideOrientation, getIndices: () => mesh.getIndices(), getVerticesData: () => mm };
  const exported = encodeBinarySTL([{ mesh: proxy }], 'support-spike');
  return { engine, exported, sideOrientation: mesh.sideOrientation ?? null, materialSide: mesh.material?.sideOrientation ?? null };
}

function setCulling(on: boolean) {
  layers?.setCulling(on);
}

function clear() {
  for (const id of lastBuild.keys()) layers?.removeSupports(id);
  lastBuild.clear();
}

function meshes() {
  return [...lastBuild.keys()].flatMap((id) => layers?.supportLayer(id)?.mesh ?? []);
}

export function installSupportSpike(): void {
  const w = window as any;
  w.__mxSupportSpike = runSupportSpike;
  w.__mxSupportSpikeTools = { stlFiles, setCulling, clear, meshes };
}
