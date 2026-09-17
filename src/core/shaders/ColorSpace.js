// Colour-space helpers for the shader colour contract (Blueprint §10,
// 2026-09-17). A ShaderEntry's `diffuseColor` hex is ALWAYS sRGB — what the
// picker shows and what exported files carry. Babylon's PBR materials bind
// `albedoColor` / `baseColor` RAW to a shader that treats it as LINEAR (the
// glTF loader stores the linear `baseColorFactor` into it unchanged), so the
// hex must be gamma→linear on the way in and linear→gamma on the way out.
// StandardMaterial `diffuseColor` is gamma-space by Babylon convention and is
// never converted. Pure functions — no Babylon dependency — so the headless
// shim (tests/env.mjs, plain-object Color3) behaves exactly like the runtime.

const _clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

/** Standard piecewise sRGB decode: sRGB [0,1] → linear [0,1]. */
export function srgbToLinear01(c) {
  const v = _clamp01(c);
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Standard piecewise sRGB encode: linear [0,1] → sRGB [0,1]. */
export function linearToSrgb01(c) {
  const v = _clamp01(c);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** True when a material stores its solid colour in linear space (PBR). */
export function isLinearColorMaterial(mat) {
  return !!mat && !mat.diffuseColor && !!(mat.albedoColor || mat.baseColor);
}

/**
 * A material's solid colour as sRGB {r,g,b} in [0,1] — the value export
 * writers must serialise. Standard `diffuseColor` is returned raw; a PBR
 * `albedoColor`/`baseColor` is converted linear→sRGB exactly once.
 * @returns {{r:number,g:number,b:number}|null} null when the material has no colour.
 */
export function materialSrgbColor(mat) {
  if (!mat) return null;
  if (mat.diffuseColor) return mat.diffuseColor;
  const c = mat.albedoColor || mat.baseColor;
  if (!c) return null;
  return { r: linearToSrgb01(c.r), g: linearToSrgb01(c.g), b: linearToSrgb01(c.b) };
}
