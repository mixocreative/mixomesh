"""Read exported print files with independent libraries and report facts.

Consumer half of tests/consumers.mjs. Nothing here imports MIXOMESH code:
trimesh reads STL / OBJ (+MTL +PNG) / PLY / 3MF geometry, pymeshlab reads
VRML, and the 3MF Materials Extension (colour groups, textures) is read
from the package XML per the 3MF spec. Run with an isolated interpreter:

    python -I tests/consumers.py <jobs.json>

jobs.json: [{"id": str, "path": str, "format": "3mf"|"obj"|"stl"|"ply"|"wrl",
"up": "z"|"y", "corners": bool}]. Prints one JSON list, one entry per job:
facet count, bounds and welded watertight / volume in the printer frame
(Z up; a Y-up file is turned with (x, y, z) -> (x, -z, y)), the colours seen
on faces facing each axis direction, the vertex positions of a small mesh
relative to its bounding-box minimum, the colour at four points just inside
the corners of a flat part (`corners`), and part names.
"""
import io
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image

NS_CORE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
NS_MAT = "http://schemas.microsoft.com/3dmanufacturing/material/2015/02"
NS_PROD = "http://schemas.microsoft.com/3dmanufacturing/production/2015/06"


def hex_rgb(rgb):
    return "#%02X%02X%02X" % tuple(int(round(c)) for c in rgb[:3])


class Model:
    """Triangles in one frame with optional colour sources."""

    def __init__(self, vertices, faces):
        self.vertices = np.asarray(vertices, dtype=np.float64).reshape(-1, 3)
        self.faces = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
        self.face_rgb = [None] * len(self.faces)       # solid colour per face
        self.vertex_rgb = None                         # per vertex
        self.corner_uv = [None] * len(self.faces)      # (3, 2) per face
        self.face_image = [None] * len(self.faces)     # PIL image per face
        self.names = []
        self.part_colours = {}                         # 3MF object id -> colours

    def append(self, other):
        base = len(self.vertices)
        self.vertices = np.vstack([self.vertices, other.vertices])
        self.faces = np.vstack([self.faces, other.faces + base])
        self.face_rgb += other.face_rgb
        self.corner_uv += other.corner_uv
        self.face_image += other.face_image
        self.names += other.names
        for k, v in other.part_colours.items():
            self.part_colours.setdefault(k, set()).update(v)


def sample(image, uv):
    """Nearest texel; uv origin bottom-left (3MF, OBJ, VRML)."""
    w, h = image.size
    u = uv[0] % 1.0
    v = uv[1] % 1.0
    x = min(int(u * w), w - 1)
    y = min(int((1.0 - v) * h), h - 1)
    return image.convert("RGB").getpixel((x, y))


# ---- 3MF -----------------------------------------------------------------

def _matrix(text):
    if not text:
        return np.eye(4)
    m = [float(x) for x in text.split()]
    out = np.eye(4)
    out[:3, :3] = np.array(m[:9]).reshape(3, 3).T
    out[:3, 3] = m[9:12]
    return out


def read_3mf(path):
    zf = zipfile.ZipFile(path)
    docs = {}

    def doc(part):
        part = part.lstrip("/")
        if part not in docs:
            docs[part] = ET.fromstring(zf.read(part))
        return docs[part]

    rels = ET.fromstring(zf.read("_rels/.rels"))
    root_part = next(r.get("Target") for r in rels if r.get("Type", "").endswith("/3dmodel"))
    images = {}

    def resources(part):
        res = doc(part).find(f"{{{NS_CORE}}}resources")
        colors, texgroups, textures, objects = {}, {}, {}, {}
        for el in res:
            tag = el.tag.split("}")[1]
            if tag == "colorgroup":
                colors[el.get("id")] = [c.get("color") for c in el]
            elif tag == "texture2d":
                textures[el.get("id")] = el.get("path")
            elif tag == "texture2dgroup":
                texgroups[el.get("id")] = (el.get("texid"), [(float(c.get("u")), float(c.get("v"))) for c in el])
            elif tag == "object":
                objects[el.get("id")] = el
        return colors, texgroups, textures, objects

    def image(tex_path):
        if tex_path not in images:
            images[tex_path] = Image.open(io.BytesIO(zf.read(tex_path.lstrip("/"))))
        return images[tex_path]

    def build_object(part, oid, matrix):
        colors, texgroups, textures, objects = resources(part)
        obj = objects[oid]
        model = Model(np.zeros((0, 3)), np.zeros((0, 3)))
        mesh = obj.find(f"{{{NS_CORE}}}mesh")
        if mesh is not None:
            verts = np.array([[float(v.get(a)) for a in "xyz"] for v in mesh.find(f"{{{NS_CORE}}}vertices")])
            verts = (matrix @ np.c_[verts, np.ones(len(verts))].T).T[:, :3]
            tris = list(mesh.find(f"{{{NS_CORE}}}triangles"))
            m = Model(verts, [[int(t.get(k)) for k in ("v1", "v2", "v3")] for t in tris])
            m.names = [obj.get("name") or ""]
            m.part_colours = {}
            for i, t in enumerate(tris):
                pid = t.get("pid") or obj.get("pid")
                p = [t.get("p1"), t.get("p2"), t.get("p3")]
                if p[0] is None:
                    p = [obj.get("pindex")] * 3
                p = [p[0] if q is None else q for q in p]
                if pid in colors:
                    c = colors[pid][int(p[0])]
                    m.face_rgb[i] = tuple(int(c[k:k + 2], 16) for k in (1, 3, 5))
                    m.part_colours.setdefault(oid, set()).add(hex_rgb(m.face_rgb[i]))
                elif pid in texgroups:
                    texid, coords = texgroups[pid]
                    m.corner_uv[i] = np.array([coords[int(q)] for q in p])
                    m.face_image[i] = image(textures[texid])
            model.append(m)
        comps = obj.find(f"{{{NS_CORE}}}components")
        if comps is not None:
            names = []
            for c in comps:
                sub_part = c.get(f"{{{NS_PROD}}}path") or part
                sub = build_object(sub_part, c.get("objectid"), matrix @ _matrix(c.get("transform")))
                names += sub.names
                model.append(sub)
            model.names = [obj.get("name") or ""] + names
        return model

    out = Model(np.zeros((0, 3)), np.zeros((0, 3)))
    for item in doc(root_part).find(f"{{{NS_CORE}}}build"):
        out.append(build_object(item.get(f"{{{NS_PROD}}}path") or root_part, item.get("objectid"), _matrix(item.get("transform"))))
    bambu = None
    if "Metadata/model_settings.config" in zf.namelist():
        bambu = bambu_settings(zf)
        for obj in bambu["objects"]:
            for part in obj["parts"]:
                part["colours"] = sorted(out.part_colours.get(part["id"], []))
    return out, bambu


def bambu_settings(zf):
    cfg = ET.fromstring(zf.read("Metadata/model_settings.config"))
    colours = json.loads(zf.read("Metadata/project_settings.config")).get("filament_colour", [])
    objects = []
    for obj in cfg.findall("object"):
        meta = lambda el, key: next((m.get("value") for m in el.findall("metadata") if m.get("key") == key), None)
        parts = [{"id": p.get("id"), "name": meta(p, "name"), "extruder": int(meta(p, "extruder") or 0)} for p in obj.findall("part")]
        objects.append({"name": meta(obj, "name"), "parts": parts})
    return {"filament_colour": colours, "objects": objects}


# ---- OBJ / PLY / STL / VRML ---------------------------------------------

def read_trimesh(path):
    loaded = trimesh.load(path, process=False, split_object=True, group_material=False)
    geoms = list(loaded.geometry.items()) if isinstance(loaded, trimesh.Scene) else [(Path(path).stem, loaded)]
    out = Model(np.zeros((0, 3)), np.zeros((0, 3)))
    for name, g in geoms:
        m = Model(g.vertices, g.faces)
        m.names = [name]
        vis = g.visual
        mat = getattr(vis, "material", None)
        img = getattr(mat, "image", None)
        uv = getattr(vis, "uv", None)
        if img is not None and uv is not None and len(uv):
            uv = np.asarray(uv)
            for i, f in enumerate(g.faces):
                m.corner_uv[i] = uv[f]
                m.face_image[i] = img
        elif mat is not None and hasattr(mat, "main_color"):
            m.face_rgb = [tuple(int(c) for c in mat.main_color[:3])] * len(g.faces)
        out.append(m)
    raw = (getattr(loaded, "metadata", {}) or {}).get("_ply_raw", {}).get("vertex", {}).get("data")
    if raw is not None and "red" in raw.dtype.names:
        out.vertex_rgb = np.stack([raw[k] for k in ("red", "green", "blue")], axis=1).astype(float)
        out.face_rgb = [None] * len(out.faces)
    return out


def read_wrl(path):
    import pymeshlab
    ms = pymeshlab.MeshSet()
    ms.load_new_mesh(str(path))
    mm = ms.current_mesh()
    m = Model(mm.vertex_matrix(), mm.face_matrix())
    text = Path(path).read_text(encoding="utf-8")
    m.names = re.findall(r"DEF (\S+) Shape", text)
    url = re.search(r'ImageTexture\s*\{\s*url\s*"([^"]+)"', text)
    if url and mm.has_wedge_tex_coord():
        img = Image.open(Path(path).parent / url.group(1))
        wedge = mm.wedge_tex_coord_matrix().reshape(-1, 3, 2)
        for i in range(len(m.faces)):
            m.corner_uv[i] = wedge[i]
            m.face_image[i] = img
    elif mm.has_vertex_color():
        m.vertex_rgb = mm.vertex_color_matrix()[:, :3] * 255.0
    return m


# ---- facts ---------------------------------------------------------------

def face_colour(m, i):
    if m.face_rgb[i] is not None:
        return m.face_rgb[i]
    if m.vertex_rgb is not None:
        return tuple(np.mean(m.vertex_rgb[m.faces[i]], axis=0))
    if m.face_image[i] is not None:
        return sample(m.face_image[i], np.mean(m.corner_uv[i], axis=0))
    return None


def colour_at(m, p):
    """Colour of the surface at point p, which lies in the part's plane."""
    best = None
    for i, f in enumerate(m.faces):
        a, b, c = m.vertices[f]
        n = np.cross(b - a, c - a)
        if np.linalg.norm(n) < 1e-12:
            continue
        bary = trimesh.triangles.points_to_barycentric(np.array([[a, b, c]]), np.array([p]))[0]
        if bary.min() < -1e-6:
            continue
        if m.face_image[i] is not None:
            return hex_rgb(sample(m.face_image[i], bary @ m.corner_uv[i]))
        if m.vertex_rgb is not None:
            best = hex_rgb(m.vertex_rgb[f[int(np.argmax(bary))]])
    return best


def facts(job):
    fmt = job["format"]
    bambu = None
    if fmt == "3mf":
        m, bambu = read_3mf(job["path"])
    elif fmt == "wrl":
        m = read_wrl(job["path"])
    else:
        m = read_trimesh(job["path"])
    if job.get("up") == "y":
        v = m.vertices.copy()
        m.vertices = np.c_[v[:, 0], -v[:, 2], v[:, 1]]
    welded = trimesh.Trimesh(m.vertices, m.faces, process=True)
    lo, hi = m.vertices.min(axis=0), m.vertices.max(axis=0)
    by_axis = {}
    for i, f in enumerate(m.faces):
        a, b, c = m.vertices[f]
        n = np.cross(b - a, c - a)
        if np.linalg.norm(n) < 1e-12:
            continue
        n = n / np.linalg.norm(n)
        k = int(np.argmax(np.abs(n)))
        axis = ("+" if n[k] > 0 else "-") + "xyz"[k]
        col = face_colour(m, i)
        if col is not None:
            by_axis.setdefault(axis, set()).add(hex_rgb(col))
    out = {
        "id": job["id"],
        "facets": int(len(m.faces)),
        "min": lo.tolist(),
        "max": hi.tolist(),
        "watertight": bool(welded.is_watertight),
        "windingConsistent": bool(welded.is_winding_consistent),
        "volume": float(welded.volume) if welded.is_watertight else None,
        "faceColours": {k: sorted(v) for k, v in sorted(by_axis.items())},
        "names": m.names,
        "bambu": bambu,
    }
    unique = np.unique(np.round(m.vertices - lo, 2), axis=0)
    if len(unique) <= 16:
        out["points"] = unique.tolist()
    if job.get("corners"):
        flat = int(np.argmin(hi - lo))
        u, w = [a for a in range(3) if a != flat]
        out["corners"] = {}
        for fu, fw, label in ((0.15, 0.15, "low-low"), (0.85, 0.15, "high-low"), (0.85, 0.85, "high-high"), (0.15, 0.85, "low-high")):
            p = (lo + hi) / 2
            p[u] = lo[u] + fu * (hi[u] - lo[u])
            p[w] = lo[w] + fw * (hi[w] - lo[w])
            out["corners"][label] = colour_at(m, p)
        out["cornerAxes"] = "xyz"[u] + "xyz"[w]
    return out


def main(jobs_path):
    jobs = json.loads(Path(jobs_path).read_text(encoding="utf-8"))
    results = []
    for job in jobs:
        try:
            results.append(facts(job))
        except Exception as err:  # one unreadable file must not hide the rest
            results.append({"id": job["id"], "error": f"{type(err).__name__}: {err}"})
    print(json.dumps(results))


if __name__ == "__main__":
    main(sys.argv[1])
