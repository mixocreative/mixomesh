import { textureViewKey } from '../assets/TextureView.js';

const UNSUPPORTED_FIELDS = Object.freeze([
  'clearCoat',
  'sheen',
  'subSurface',
  'anisotropy',
  'iridescence',
  'emissiveTextureAssetId',
  'normalTextureAssetId',
]);

const valueEnabled = value => value === true
  || typeof value === 'number' && value !== 0
  || typeof value === 'string' && value !== ''
  || value && typeof value === 'object' && value.isEnabled !== false;

function textureIdentity(shader, assets) {
  const id = shader.diffuseTextureAssetId;
  if (!id) return null;
  const asset = assets?.[id];
  if (!asset?.imageContentHash || !asset.textureView) return `asset:${id}`;
  return textureViewKey({ ...asset.textureView, imageContentHash: asset.imageContentHash });
}

/** Exact normalized identity over every appearance field MIXOMESH preserves. */
export function shaderSignature(shader, { assets = {}, material = null } = {}) {
  const reasons = [];
  for (const field of UNSUPPORTED_FIELDS) {
    if (valueEnabled(shader?.[field])) reasons.push(field);
  }
  // Babylon exposes feature plugins through lazy public getters. Reading
  // those getters merely to compare identity can instantiate plugins and
  // trigger shader recompilation, so inspect already-created internals only.
  const materialPlugins = {
    clearCoat: material?._clearCoat,
    sheen: material?._sheen,
    subSurface: material?._subSurface,
    anisotropy: material?._anisotropic,
    iridescence: material?._iridescence,
  };
  for (const [field, plugin] of Object.entries(materialPlugins)) {
    if (valueEnabled(plugin) && !reasons.includes(field)) reasons.push(field);
  }
  const materialTextures = {
    normalTexture: material?._bumpTexture,
    emissiveTexture: material?._emissiveTexture,
    opacityTexture: material?._opacityTexture,
    ambientTexture: material?._ambientTexture,
    specularTexture: material?._specularTexture,
    reflectionTexture: material?._reflectionTexture,
    refractionTexture: material?._refractionTexture,
    lightmapTexture: material?._lightmapTexture,
  };
  for (const [field, texture] of Object.entries(materialTextures)) {
    if (texture && !reasons.includes(field)) reasons.push(field);
  }
  const uv = shader?.uvBase ?? {};
  const key = JSON.stringify([
    shader?.type ?? 'standard',
    String(shader?.diffuseColor ?? '#b3b3b3').toLowerCase(),
    shader?.opacity ?? 1,
    shader?.roughness ?? 0.5,
    shader?.metallic ?? 0,
    uv.offsetX ?? 0,
    uv.offsetY ?? 0,
    uv.scaleX ?? 1,
    uv.scaleY ?? 1,
    uv.rotation ?? 0,
    textureIdentity(shader ?? {}, assets),
  ]);
  return { eligible: reasons.length === 0, key, reasons };
}

/** Candidate projection only; consolidation remains an explicit user command. */
export function findDuplicateShaderGroups(shaders, { assets = {} } = {}) {
  const byKey = new Map();
  for (const shader of shaders) {
    const signature = shaderSignature(shader, { assets });
    if (!signature.eligible) continue;
    if (!byKey.has(signature.key)) byKey.set(signature.key, []);
    byKey.get(signature.key).push(shader);
  }
  return [...byKey.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({
      key,
      canonicalId: group[0].id,
      duplicateIds: group.slice(1).map(shader => shader.id),
      shaderIds: group.map(shader => shader.id),
      linkedObjectCount: group.reduce((sum, shader) => sum + (shader.linkedMeshIds?.length ?? 0), 0),
    }));
}
