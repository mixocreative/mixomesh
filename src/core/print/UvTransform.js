// The texture coordinates a writer emits: the mesh's UVs with its base-colour
// texture's offset / scale / rotation (UV Override, glTF KHR_texture_transform)
// baked in, exactly as Babylon's vertex shader applies them
// (`vUV = vec2(textureMatrix * vec4(uv, 1.0, 0.0))`), so the print shows the
// mapping the viewport shows (cia C-04).

/** The base-colour texture an export ships for a material (diffuse / albedo / base). */
export function baseColorTexture(mat) {
  return mat ? (mat.diffuseTexture || mat.albedoTexture || mat.baseTexture || null) : null;
}

/**
 * Apply a Babylon texture matrix (column-major `m`, as uploaded to the shader)
 * to an interleaved u,v array.
 * @param {ArrayLike<number>} uvs
 * @param {ArrayLike<number>} m 16 entries
 * @returns {number[]}
 */
export function applyTextureMatrix(uvs, m) {
  const out = new Array(uvs.length);
  for (let i = 0; i + 1 < uvs.length; i += 2) {
    const u = uvs[i], v = uvs[i + 1];
    out[i] = m[0] * u + m[4] * v + m[8];
    out[i + 1] = m[1] * u + m[5] * v + m[9];
  }
  return out;
}

const ADDRESS_MODES = { 0: 'clamp', 1: 'wrap', 2: 'mirror' };

/**
 * How the viewport samples UVs outside [0,1] (Babylon `wrapU` / `wrapV`), so
 * a writer can say the same in its format.
 * @returns {{u:'wrap'|'clamp'|'mirror', v:'wrap'|'clamp'|'mirror'}}
 */
export function textureAddressing(texture) {
  return { u: ADDRESS_MODES[texture?.wrapU] ?? 'wrap', v: ADDRESS_MODES[texture?.wrapV] ?? 'wrap' };
}

function _isIdentityUV(m) {
  return m[0] === 1 && m[1] === 0 && m[4] === 0 && m[5] === 1 && m[8] === 0 && m[9] === 0;
}

/**
 * The UVs to write for `mesh`: raw UVs when the mesh has no transformed
 * base-colour texture, else the coordinates Babylon samples that texture at.
 * @returns {ArrayLike<number>|null}
 */
export function exportUVs(mesh) {
  const uvs = mesh?.getVerticesData?.('uv') ?? null;
  if (!uvs?.length) return uvs;
  const m = baseColorTexture(mesh.material)?.getTextureMatrix?.()?.m;
  if (!m || _isIdentityUV(m)) return uvs;
  return applyTextureMatrix(uvs, m);
}

const UV_EDGE_EPSILON = 1e-6;

/**
 * True when the viewport clamps this mesh's base-colour texture on an axis
 * whose exported UVs leave [0,1]: the print then depends on the format
 * carrying the clamp (3MF tilestyle, VRML repeatS/T). OBJ/MTL cannot say it
 * (`-clamp on` breaks trimesh), so an OBJ export of such a mesh repeats the
 * texture where the viewport shows the edge texel.
 */
export function clampedUVsLeaveUnitSquare(mesh) {
  const texture = baseColorTexture(mesh?.material);
  if (!texture) return false;
  const { u, v } = textureAddressing(texture);
  if (u !== 'clamp' && v !== 'clamp') return false;
  const uvs = exportUVs(mesh);
  if (!uvs?.length) return false;
  const outside = (x) => x < -UV_EDGE_EPSILON || x > 1 + UV_EDGE_EPSILON;
  for (let i = 0; i + 1 < uvs.length; i += 2) {
    if ((u === 'clamp' && outside(uvs[i])) || (v === 'clamp' && outside(uvs[i + 1]))) return true;
  }
  return false;
}
