/**
 * Shared support-layer materials (plan P3.3): one material per part kind, made once per scene and
 * shared by every object's support mesh through one MultiMaterial (a sub-mesh per kind), so a new
 * preview build swaps geometry only and never compiles a shader again. Stale supports swap to the
 * grey twin of the same MultiMaterial layout.
 */
import type { SupportComponent } from '@mixo-geocore/host/core/supports/mesh';

/* eslint-disable @typescript-eslint/no-explicit-any -- Babylon is the untyped window global here */

export const PART_KINDS = ['tip', 'neck', 'pillar', 'foot', 'tree', 'brace', 'raft', 'label', 'roof', 'cage'] as const;
export type PartKind = (typeof PART_KINDS)[number];

/** Material slot (sub-mesh material index) of a part kind. */
export const KIND_INDEX: Readonly<Record<PartKind, number>> = Object.fromEntries(PART_KINDS.map((k, i) => [k, i])) as Record<PartKind, number>;

/** The material kind of a built component. */
export function partKind(component: Pick<SupportComponent, 'part' | 'structureKind'>): PartKind {
  switch (component.part) {
    case 'tip': return 'tip';
    case 'neck': return component.structureKind === 'tree' ? 'tree' : 'neck';
    case 'pillar': return 'pillar';
    case 'foot': return 'foot';
    case 'tree-branch':
    case 'tree-trunk': return 'tree';
    case 'brace': return 'brace';
    case 'raft': return 'raft';
    case 'label': return 'label';
    case 'roof':
    case 'column':
    case 'roof-brace': return 'roof';
    case 'cross-bar':
    case 'cage-ring': return 'cage';
    default: return 'pillar';
  }
}

/** Viewport colours per kind (support grey-blues; tips lighter so contacts read). */
const KIND_COLOR: Readonly<Record<PartKind, string>> = {
  tip: '#b9c6d3',
  neck: '#9fb0c2',
  pillar: '#8fa3b8',
  foot: '#7d8fa3',
  tree: '#93a88f',
  brace: '#a39a8a',
  raft: '#8a8478',
  label: '#c2b59b',
  roof: '#a08fa3',
  cage: '#8f9fa8',
};
const STALE_COLOR = '#9a9a9a';

export interface SupportMaterials {
  /** MultiMaterial, sub-material `KIND_INDEX[kind]` per kind. */
  kinds: any;
  /** Same layout, every slot the stale grey. */
  stale: any;
  /** Every material made here (tests, culling toggles). */
  all: any[];
}

const perScene = new WeakMap<object, SupportMaterials>();

function standard(B: any, name: string, hex: string, scene: any) {
  const m = new B.StandardMaterial(name, scene);
  m.diffuseColor = B.Color3.FromHexString(hex);
  m.specularColor = new B.Color3(0.08, 0.08, 0.08);
  m.backFaceCulling = true;
  return m;
}

export function supportMaterials(B: any, scene: any): SupportMaterials {
  const known = perScene.get(scene);
  if (known && !known.kinds.isDisposed?.()) return known;
  const all: any[] = [];
  const kinds = new B.MultiMaterial('mx-support-kinds', scene);
  for (const kind of PART_KINDS) {
    const m = standard(B, `mx-support-${kind}`, KIND_COLOR[kind], scene);
    kinds.subMaterials.push(m);
    all.push(m);
  }
  const grey = standard(B, 'mx-support-stale', STALE_COLOR, scene);
  grey.alpha = 0.55;
  all.push(grey);
  const stale = new B.MultiMaterial('mx-support-stale-kinds', scene);
  for (let i = 0; i < PART_KINDS.length; i++) stale.subMaterials.push(grey);
  const made = { kinds, stale, all };
  perScene.set(scene, made);
  return made;
}

/** An unlit overlay material (rings, ghost tip, zones), made once per scene and name. */
const overlays = new WeakMap<object, Map<string, any>>();
export function overlayMaterial(B: any, scene: any, name: string, hex: string, alpha: number, onTop = false): any {
  let byName = overlays.get(scene);
  if (!byName) overlays.set(scene, (byName = new Map()));
  const known = byName.get(name);
  if (known && !known.isDisposed?.()) return known;
  const m = new B.StandardMaterial(`mx-support-${name}`, scene);
  m.disableLighting = true;
  m.emissiveColor = B.Color3.FromHexString(hex);
  m.diffuseColor = new B.Color3(0, 0, 0);
  m.specularColor = new B.Color3(0, 0, 0);
  m.alpha = alpha;
  m.backFaceCulling = false;
  if (onTop) m.disableDepthWrite = true;
  m.zOffset = -2;
  byName.set(name, m);
  return m;
}
