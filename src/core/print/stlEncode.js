// Pure binary STL encoder (no imports): shared by StlWriter.js on the main
// thread and workers/StlEncode.worker.js, which has no window/Babylon.

/**
 * Encode print-space parts as one binary STL, straight into one buffer (no
 * per-facet arrays — those dominated memory on big exports). Pure: runs on
 * the main thread or in workers/StlEncode.worker.js.
 * @param {Array<{name?: string, positions: Float32Array, indices: ArrayLike<number>}>} parts
 * @param {string} [solidName]  written into the 80-byte header (ASCII, truncated)
 * @returns {Uint8Array}
 */
export function encodeBinarySTLFromArrays(parts, solidName = 'mixomesh') {
  let count = 0;
  for (const { name, positions: pos, indices: idx } of parts) {
    for (let i = 0; i + 2 < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      if (a + 2 >= pos.length || b + 2 >= pos.length || c + 2 >= pos.length) {
        throw new Error(`StlWriter: triangle index out of range in "${name ?? '?'}"`);
      }
      count++;
    }
  }
  const bytes = new Uint8Array(84 + count * 50);
  const view = new DataView(bytes.buffer);
  const header = `mixomesh binary STL ${solidName}`.slice(0, 79);
  for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i) & 0x7f;
  view.setUint32(80, count, true);
  let o = 84;
  for (const { positions: pos, indices: idx } of parts) {
    for (let i = 0; i + 2 < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
      const bx = pos[b], by = pos[b + 1], bz = pos[b + 2];
      const cx = pos[c], cy = pos[c + 1], cz = pos[c + 2];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      view.setFloat32(o, len > 0 ? nx / len : 0, true);
      view.setFloat32(o + 4, len > 0 ? ny / len : 0, true);
      view.setFloat32(o + 8, len > 0 ? nz / len : 0, true);
      view.setFloat32(o + 12, ax, true); view.setFloat32(o + 16, ay, true); view.setFloat32(o + 20, az, true);
      view.setFloat32(o + 24, bx, true); view.setFloat32(o + 28, by, true); view.setFloat32(o + 32, bz, true);
      view.setFloat32(o + 36, cx, true); view.setFloat32(o + 40, cy, true); view.setFloat32(o + 44, cz, true);
      view.setUint16(o + 48, 0, true);
      o += 50;
    }
  }
  return bytes;
}

