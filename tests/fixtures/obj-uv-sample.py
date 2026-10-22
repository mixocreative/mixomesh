"""Sample an exported OBJ's texture through trimesh at barycentric points.

Independent consumer for tests/browser-uv-transform-c04.mjs (cia C-04):
trimesh reads the OBJ + MTL + PNG; this script interpolates trimesh's UVs at
each sample's barycentric point and asks trimesh for the texel colour there.
Run with an isolated interpreter:

    python -I tests/fixtures/obj-uv-sample.py <file.obj> <samples.json>

samples.json: [{"verts": [i0, i1, i2], "bary": [b0, b1, b2]}, ...] where i is
the OBJ's own vertex order (the `v` lines). Prints one JSON object per sample
with the interpolated uv and the RGBA trimesh returns.
"""
import json
import sys

import numpy as np
import trimesh
from trimesh.visual.color import uv_to_color


def obj_positions(path):
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.startswith("v "):
                out.append([float(x) for x in line.split()[1:4]])
    return np.array(out)


def main(obj_path, samples_path):
    mesh = trimesh.load(obj_path, process=False, force="mesh")
    image = mesh.visual.material.image
    uv = np.asarray(mesh.visual.uv, dtype=np.float64)
    file_pos = obj_positions(obj_path)
    index = []
    for p in file_pos:
        d = np.linalg.norm(mesh.vertices - p, axis=1)
        index.append(int(np.argmin(d)))
        if d.min() > 1e-4:
            raise SystemExit(f"OBJ vertex {p} not found in trimesh's mesh")
    with open(samples_path, encoding="utf-8") as f:
        samples = json.load(f)
    pts = np.array([sum(b * uv[index[i]] for i, b in zip(s["verts"], s["bary"])) for s in samples])
    colours = uv_to_color(pts, image)
    print(json.dumps([{"uv": p.tolist(), "rgba": c.tolist()} for p, c in zip(pts, colours)]))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
