export const SUPPORTED_EXTENSIONS = ['.glb', '.gltf', '.obj', '.stl', '.3mf'];
export const SUPPORTED_TEXTURE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

export function extOf(filename) {
  const value = String(filename ?? '');
  const i = value.lastIndexOf('.');
  return i === -1 ? '' : value.slice(i).toLowerCase();
}

export function isMeshExt(ext) {
  return SUPPORTED_EXTENSIONS.includes(String(ext ?? '').toLowerCase());
}

export function isTextureExt(ext) {
  return SUPPORTED_TEXTURE_EXTENSIONS.includes(String(ext ?? '').toLowerCase());
}
