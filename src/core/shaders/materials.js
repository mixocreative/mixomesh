// Colour conversion and Babylon material construction: the two pure-ish jobs the shader library
// kept inline. Cut out of ShaderLibrary.js on 2026-11-14 (122 lines of a 1,091-line file).
//
// THE CONTRACT THIS FILE EXISTS TO HOLD (Blueprint §10, 2026-09-17): a ShaderEntry's
// `diffuseColor` hex is ALWAYS sRGB. PBR materials store `albedoColor` / `baseColor` in LINEAR
// space — Babylon binds it raw, and glTF's `baseColorFactor` lands there unchanged — so every
// hex↔PBR mapping here converts EXACTLY ONCE. Standard and unlit `diffuseColor` is gamma-space by
// Babylon convention and is copied raw.
//
// That "exactly once" is the whole point of putting these together in one file: a second place
// that converts is a second answer to what colour something is, and a double conversion is a bug
// nobody sees until they compare an import against its source.

import { srgbToLinear01, linearToSrgb01 } from './ColorSpace.js';
import { AssetLoader } from '../AssetLoader.js';

const BABYLON = window.BABYLON;

/** The colour anything unreadable falls back to, so a bad hex never yields a black model. */
export const FALLBACK_DIFFUSE = '#cccccc';

/** Pass as the options argument whenever the Color3 in hand is a PBR albedo (linear space). */
export const LINEAR = { linear: true };

/**
 * Color3 → '#rrggbb' (sRGB). Pass `{ linear: true }` when the source is a PBR
 * albedo so the channels are gamma-encoded first.
 */
export function color3ToHex(c3, { linear = false } = {}) {
  if (!c3) return FALLBACK_DIFFUSE;
  const enc = (v) => Math.round(Math.max(0, Math.min(1, linear ? linearToSrgb01(v) : v)) * 255);
  return '#' + [enc(c3.r), enc(c3.g), enc(c3.b)].map(v => v.toString(16).padStart(2, '0')).join('');
}

/**
 * '#rrggbb' (sRGB) → Color3. Pass `{ linear: true }` for a PBR albedo target so
 * the channels are decoded to linear space.
 */
export function hexToColor3(hex, { linear = false } = {}) {
  let c;
  try { c = BABYLON.Color3.FromHexString(hex); }
  catch { c = BABYLON.Color3.FromHexString(FALLBACK_DIFFUSE); }
  if (!c || typeof c.r !== 'number') c = BABYLON.Color3.FromHexString(FALLBACK_DIFFUSE);
  return linear
    ? new BABYLON.Color3(srgbToLinear01(c.r), srgbToLinear01(c.g), srgbToLinear01(c.b))
    : c;
}

export function detectType(material) {
  if (material instanceof BABYLON.PBRMaterial)                  return 'pbr';
  if (material instanceof BABYLON.PBRMetallicRoughnessMaterial) return 'pbr';
  if (material instanceof BABYLON.PBRSpecularGlossinessMaterial) return 'pbr';
  if (material.disableLighting === true)                        return 'unlit';
  return 'standard';
}

/**
 * User-facing shader name for an imported material. Babylon's glTF loader
 * names the material it synthesises for material-less primitives
 * "__GLTFLoader._default" — an internal token that surfaced verbatim in the
 * shader library (owner sweep 2026-09-18). Loader-internal names map to a
 * plain "Default"; everything else keeps the file's own material name.
 */
export function importedMaterialName(material) {
  const raw = String(material?.name ?? '').trim();
  if (!raw) return 'Material';
  if (/^__GLTFLoader\._default$/i.test(raw) || /^__/.test(raw)) return 'Default';
  return raw;
}

export function createBabylonMaterial(type, name, scene) {
  if (type === 'pbr') {
    const m = new BABYLON.PBRMaterial(name, scene);
    m.metallic  = 0;
    m.roughness = 0.5;
    return m;
  }
  if (type === 'unlit') {
    const m = new BABYLON.StandardMaterial(name, scene);
    m.disableLighting = true;
    m.emissiveColor   = new BABYLON.Color3(1, 1, 1);
    return m;
  }
  return new BABYLON.StandardMaterial(name, scene);
}

/**
 * A ShaderEntry from an imported Babylon material.
 *
 * `id` is passed in rather than minted here: the id counter belongs to the library that owns the
 * entries, and a module that both mints ids and builds entries cannot be called twice in a test
 * without inventing ids nobody asked for.
 *
 * @param {object} material the imported Babylon material
 * @param {string} id the id the library has minted for this entry
 * @param {object} [importCtx] scopes texture dedupe to the source file (§10b)
 */
export function buildEntryFromMaterial(material, id, importCtx = {}) {
  const type = detectType(material);
  let diffuseColor = FALLBACK_DIFFUSE;
  let opacity = 1, roughness = 0.5, metallic = 0;

  if (type === 'pbr') {
    // Imported PBR albedo is already linear (glTF baseColorFactor) — encode once.
    diffuseColor = color3ToHex(material.albedoColor ?? material.baseColor, LINEAR);
    opacity      = material.alpha ?? 1;
    roughness    = material.roughness ?? 0.5;
    metallic     = material.metallic ?? 0;
  } else {
    diffuseColor = color3ToHex(material.diffuseColor);
    opacity      = material.alpha ?? 1;
  }

  // Whatever texture the material arrived with becomes a texture asset so the
  // user can preview it, swap it onto another shader, or replace it. The
  // import context scopes texture dedupe to the source file (§10b).
  const importedTex = material.albedoTexture ?? material.baseTexture ?? material.diffuseTexture;
  const diffuseTextureAssetId = importedTex
    ? AssetLoader.registerImportedTexture(importedTex, importCtx)
    : null;

  return {
    id,
    name: importedMaterialName(material),
    type,
    diffuseColor,
    diffuseTextureAssetId,
    // Harvest the imported texture's UV transform (KHR_texture_transform-style)
    // so a non-identity offset/scale/rotation survives import + .mixo round-trip
    // instead of being reset to identity.
    uvBase: importedTex ? {
      offsetX:  Number.isFinite(importedTex.uOffset) ? importedTex.uOffset : 0,
      offsetY:  Number.isFinite(importedTex.vOffset) ? importedTex.vOffset : 0,
      scaleX:   Number.isFinite(importedTex.uScale)  ? importedTex.uScale  : 1,
      scaleY:   Number.isFinite(importedTex.vScale)  ? importedTex.vScale  : 1,
      rotation: Number.isFinite(importedTex.wAng)    ? importedTex.wAng    : 0,
    } : { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    opacity, roughness, metallic,
    linkedMeshIds: [],
  };
}
