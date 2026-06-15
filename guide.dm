# MIXOMESH Import and Export Guide

This guide explains what happens when MIXOMESH reads a 3D file, why the same
model can import differently depending on its format, and how export decides
what data to write.

## Big Picture

MIXOMESH separates three ideas:

- The source file: GLB, GLTF, OBJ, STL, or 3MF.
- The scene object: the visible mesh currently placed in the workspace.
- The asset: a reusable item in the Asset Panel that can be dragged into the
  scene again later.

Normal mesh imports create both an asset and one or more scene objects.
Library GLBs are different: a marked GLB can create many Asset Panel entries
without placing anything into the scene.

## How Files Are Read

MIXOMESH reads model files through Babylon's `SceneLoader` where possible.
The result is an `AssetContainer`: a temporary package of meshes, materials,
textures, and transform nodes.

File reading matters because every format stores different information:

- GLB/GLTF can store hierarchy, object names, materials, embedded textures,
  UVs, and custom Blender properties exported as glTF `extras`.
- OBJ is usually multiple files: `.obj` geometry, `.mtl` material names and
  colors, and image files such as PNG/JPG. If the `.mtl` or images are not
  dropped or mounted with the OBJ, the model still imports but materials or
  textures may fall back.
- STL stores geometry only. It has no texture, shader, object hierarchy, or
  reliable color data.
- 3MF stores print-oriented geometry and color/material data. MIXOMESH supports
  the 3MF shape it writes, including color groups and texture extension data.

## Scale and Ratio

Internally, MIXOMESH uses:

- 1 Babylon unit = 1 meter.
- UI dimensions are shown in millimeters.
- Scene Scale is the working scale used while editing.
- Print Scale is the final scale used during export.

When a file imports, MIXOMESH normalizes it once:

1. Read source units, currently defaulting mesh imports to millimeters.
2. Read the model ratio from a Blender/glTF custom property named `ratio`.
3. Bake unit and ratio scale into the mesh vertices.
4. Leave the object transform clean, so Properties shows simple values.

Example Blender custom property:

```text
ratio = 1:72
```

This means the source model was authored at 1:72. MIXOMESH stores that as the
asset's `modelRatio` and imports it at the correct scene size.

## Textures and Shaders

A shader is the editable material entry MIXOMESH shows in the Shader Panel.
A texture is an image used by a shader.

On import:

- Materials from the source file become shader entries.
- Embedded GLB/3MF textures become texture assets so they can be reused or
  exported.
- Multi-material meshes are split into one mesh per material. This is required
  because MIXOMESH enforces one mesh = one shader.
- STL or material-less geometry receives the shared resin-gray default material.

Texture quality rule:

- Viewport texture caps may reduce GPU memory use while editing.
- Export reads the captured full-resolution source texture when available.
- This prevents viewport downscaling from damaging Mimaki texture output.

## GLB Library Mode

Some GLBs are not one model. They are object packs. For example:

```text
beverage.glb
  Cola
  Juice
  Coffee
```

If imported normally, that pack would enter the scene as one file drop. That is
not ideal when the file is meant to be a reusable object library.

To mark a GLB as a library, add one Empty/object as the library container.
Collections are fine for Blender organization, but MIXOMESH does not depend on
collection names or collection custom properties. Put this custom property on
the container object and export with custom properties enabled:

```text
library = 1
```

Recommended Blender hierarchy:

```text
Beverage Collection
  MIXOMESH_LIBRARY        <- Empty with library = 1
    Cola                  <- Asset Panel entry
      ColaBottleMesh
      ColaLabelMesh
    Juice                 <- Asset Panel entry
      JuiceBottleMesh
```

When MIXOMESH sees this marker:

1. It reads the GLB but does not add it to the scene.
2. It finds each direct child object below the marker that contains geometry.
3. It registers each child as its own Asset Panel entry.
4. Dragging or double-clicking one child asset imports only that object.

Geometry outside the marked container is ignored for library splitting. This
lets modelers keep scale helpers, references, or other collection contents in
the Blender file without turning them into asset entries.

Do not put `library = 1` on the Blender Scene or Collection for library mode.
Library mode needs an object boundary, and selected-object GLB exports are safest
when the selected export includes the marker Empty and its child asset groups.

If library splitting fails, MIXOMESH falls back to normal GLB import so the
file is still usable.

## Export Logic

Export is button-driven. The printer profile is only a build-area reference for
bed preview and size checks.

The Export panel buttons choose the file type:

- Export OBJ + MTL writes a ZIP containing `.obj`, `.mtl`, and texture PNGs.
- Export 3MF writes a `.3mf` package.
- Export STL writes geometry only.

3MF has two internal sub-flavors:

- If printable meshes have image textures and UVs, MIXOMESH writes 3MF Materials
  Extension data with embedded PNG textures.
- If the scene is solid-color only, MIXOMESH writes 3MF color groups for
  per-object color.

OBJ export:

- Preserves real image textures when present.
- Writes a generated MTL file whose material names match the OBJ `usemtl`
  lines.
- Can optionally bake solid shader colors to tiny PNG textures when the Export
  panel checkbox is enabled.

STL export:

- Writes geometry only.
- Does not carry color, shader, texture, or UV data.

## Practical Rules

- Use GLB/GLTF when you need hierarchy, names, shaders, UVs, textures, and
  Blender custom properties.
- Use OBJ only when you can keep `.obj`, `.mtl`, and texture image files
  together.
- Use STL only for geometry-only workflows.
- Use `ratio` custom properties for authored scale.
- Use `library = 1` for object-pack GLBs that should fill the
  Asset Panel instead of the scene. Put the marker on one Empty/object and make
  direct children under it the intended asset entries.
- Collections are safe for organization, but parent hierarchy is the import
  contract.
- Use export buttons to choose output format. Do not expect the printer profile
  to switch formats.
