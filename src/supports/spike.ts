/**
 * Support generation spike (plan 2026-10-29 P2.1). Dev-only trigger, no user UI:
 *
 *   await window.__mxSupportSpike()            // active (or first selected) logical object, MIDDLE
 *   await window.__mxSupportSpike({ preset: 'LIGHT', objectId })
 *
 * One selected logical object -> frame.ts (engine frame, welded copy) -> automatic placement (main
 * thread, generic) -> mesh worker `generate` (preview) -> frame.ts back -> one Babylon mesh.
 *
 * The drawn mesh follows D20 like the cross-section indicator / back-face clones: parent null, no
 * `metadata.meshId` (so every content walk - WorldExtents, MeshStats, validator, outline, BoxSelect,
 * export units, shadow casters - skips it), `isPickable = false`, and not in any thumbnail's visible set.
 * P3.3 replaces this with the real support layers.
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
import { AssetLoader } from '../core/AssetLoader.js';
import { canonicalObjectId, logicalObjectPartIds } from '../core/LogicalObjects.js';
import { frontFaceIsClockwise, signedVolume } from '../core/print/PrintSpace.js';
import { encodeBinarySTL } from '../core/print/StlWriter.js';
import { withRestTransform } from '../core/scene/ImportBounce.js';
import { SceneManager } from '../core/SceneManager.js';
import { ENGINE_MM_PER_BU, meshFromEngine, partsToEngine, type BabylonPart } from './frame';
import { presetSettings, supportJob, supportsToWorld, tipCount, toLocal } from './supportJob';

/* eslint-disable @typescript-eslint/no-explicit-any -- Babylon is the untyped window global here */
const BABYLON = (window as any).BABYLON;

export interface SpikeOptions {
  objectId?: string;
  preset?: PresetName;
  settings?: Partial<LiveSupportSettings>;
}

export interface SpikeResult {
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
const drawn = new Map<string, any>();
const lastBuild = new Map<string, GeneratedSupportMesh>();
let material: any;

function meshClient(): SupportMeshClient {
  client ??= new SupportMeshClient({
    create: typeof Worker === 'undefined' ? null
      : () => new Worker(meshWorkerUrl(new URL(workerUrl, document.baseURI), document.baseURI), { type: 'module' }) as any,
  });
  return client;
}

/** World-space parts of one logical object, read at rest (ImportBounce), with each part's effective front face. */
function babylonParts(objectId: string): BabylonPart[] {
  const objects = getState().scene.objects;
  return withRestTransform(() => logicalObjectPartIds(objectId, objects).flatMap((id: string) => {
    if (objects[id]?.isGhost) return [];
    const mesh = AssetLoader.getBabylonMesh?.(id);
    const local = mesh?.getVerticesData?.(BABYLON.VertexBuffer.PositionKind);
    const indices = mesh?.getIndices?.();
    if (!local?.length || !indices?.length) return [];
    const world = mesh.computeWorldMatrix(true);
    const positions = new Float32Array(local.length);
    const v = new BABYLON.Vector3();
    for (let i = 0; i < local.length; i += 3) {
      BABYLON.Vector3.TransformCoordinatesFromFloatsToRef(local[i], local[i + 1], local[i + 2], world, v);
      positions[i] = v.x; positions[i + 1] = v.y; positions[i + 2] = v.z;
    }
    // Babylon flips culling for a mirrored world matrix, so the outward order flips with it.
    const clockwise = frontFaceIsClockwise(mesh) !== (world.determinant() < 0);
    return [{ positions, indices, clockwise }];
  }));
}

function supportMaterial(scene: any) {
  if (material && !material.isDisposed?.()) return material;
  material = new BABYLON.StandardMaterial('mx-support-spike-mat', scene);
  material.diffuseColor = BABYLON.Color3.FromHexString('#8fa3b8');
  material.specularColor = new BABYLON.Color3(0.1, 0.1, 0.1);
  material.backFaceCulling = true;
  return material;
}

/** Draw (or replace) the support mesh of `objectId`: native counter-clockwise-front Babylon mesh. */
function draw(objectId: string, engineWorld: GeneratedSupportMesh) {
  const scene = SceneManager.getScene();
  drawn.get(objectId)?.dispose();
  const { positions, indices } = meshFromEngine(engineWorld, false);
  const mesh = new BABYLON.Mesh(`mx-support-spike-${objectId}`, scene);
  const data = new BABYLON.VertexData();
  data.positions = positions;
  data.indices = indices;
  const normals = new Float32Array(positions.length);
  BABYLON.VertexData.ComputeNormals(positions, indices, normals);
  data.normals = normals;
  data.applyToMesh(mesh);
  mesh.parent = null;
  mesh.isPickable = false;
  mesh.metadata = { supportLayer: true, supportOf: objectId };
  mesh.material = supportMaterial(scene);
  drawn.set(objectId, mesh);
  return mesh;
}

export async function runSupportSpike(options: SpikeOptions = {}): Promise<SpikeResult> {
  const objects = getState().scene.objects;
  const picked = options.objectId ?? Selection.getActiveId() ?? Selection.getSelectedIds()[0];
  if (!picked) throw new Error('support spike: select an object first');
  const objectId = canonicalObjectId(picked, objects);
  const parts = babylonParts(objectId);
  if (!parts.length) throw new Error(`support spike: ${objectId} has no geometry`);

  configureGeometry(geometryGlueUrl(document.baseURI));
  await geometryReady();
  const settings = { ...presetSettings(options.preset ?? 'MIDDLE'), ...options.settings };
  const engineModel = partsToEngine(parts);
  const model = toLocal(engineModel.mesh);
  const t0 = performance.now();
  const placement = placeGeneric(model.local, toPlacementSettings(settings));
  const t1 = performance.now();
  const built = await meshClient().build(objectId, supportJob(model, settings, placement), { key: 'Support building' });
  const t2 = performance.now();
  if (!built) throw new Error('support spike: build was replaced');
  const world = supportsToWorld(built, model.center);
  lastBuild.set(objectId, world);
  draw(objectId, world);
  return {
    objectId,
    parts: parts.length,
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
  const mesh = drawn.get(objectId);
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
  if (material) material.backFaceCulling = on;
}

function clear() {
  for (const mesh of drawn.values()) mesh.dispose();
  drawn.clear();
  lastBuild.clear();
}

export function installSupportSpike(): void {
  const w = window as any;
  w.__mxSupportSpike = runSupportSpike;
  w.__mxSupportSpikeTools = { stlFiles, setCulling, clear, meshes: () => [...drawn.values()] };
}
