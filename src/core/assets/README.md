# src/core/assets/ — the map

23 files: the life of an imported asset, from the bytes a user drops to the mesh in the scene and
back out of a reopened project. `../AssetLoader.js` is the façade the rest of the app calls; this
folder is the work behind it, and the split exists so the UI never has to know it.

**This is not a data folder.** `tests/fixtures/` stores assets; this is the code that decides what
an asset *is*.

## The registry — the shared state everything else reads

| File | Job |
|---|---|
| `MeshRegistry.js` | **the module-local maps every other concern here shares.** Read this first: it is the thing that makes the rest coherent, and the thing a new module here is most likely to duplicate by accident |
| `AssetIndex.js` | an immutable, path-deduplicated projection of the mounted rows — what the UI lists |
| `AssetTypes.js` | the shapes |
| `BlobUrls.js` | the one blob-URL registry, so nothing leaks a URL nobody revokes |

## Import — the live path

| File | Job |
|---|---|
| `AssetImport.js` | blob/handle → AssetContainer → scene |
| `ContainerLoad.js` | blob URL → AssetContainer, **worker first**; STL and 3MF parse and weld off the main thread |
| `ImportSession.js` | an import's lifetime: its blocking row in JobActivity, its cancel scope, its cleanup. An import without a session is an import the user cannot cancel |
| `ImportBudget.js` | the triangle budget at import time |
| `ImportDedupe.js` | re-import of something already here: find the asset whose source matches rather than minting a second one |
| `MeshSplit.js` | split-on-import, to keep **one mesh / one shader** |
| `AssetRegistration.js` | minting the SceneObject or collection: unique display names and the ids the rest of the app uses |
| `ObjSiblings.js` | OBJ's sibling files — an OBJ alone is not an OBJ, and "obj fails to read mtl" was the field report that put this here |
| `LibraryImport.js` | a glTF tagged as a Mixo library pack |

## Restore — the path a reopened project takes

| File | Job |
|---|---|
| `AssetRestore.js` | rebuild containers from saved bytes, and the duplicate path. **The restore path and the live import path must agree**; where they disagree, a project reopens subtly different from how it was saved, and only a save-reopen test notices |
| `DirMounts.js` | mounted-directory refs: File System Access handles in the browser, something else in Electron |
| `DisplayNames.js` | the name-clash rules |

## Textures

| File | Job |
|---|---|
| `TextureAssets.js` | the texture-asset registry |
| `TextureImageStore.js` | **identity is the SHA-256 of the canonical encoded bytes.** Filenames never participate — two files with one name are one texture, and one file under two names is still one |
| `TextureSource.js` | the full-res source, kept apart from what the GPU holds |
| `TextureCap.js` | the viewport's cap: downsamples the GPU copy, never the source |
| `TextureView.js` | every sampling field preserved independently of the image bytes |
| `TextureReadback.js` | **the only correct way to get pixels back off a GPU texture** (review C1). A second way is a bug |
| `AssetThumbnail.js` | idle thumbnail generation |

## The rule that holds this folder together

**An asset's identity is its content, never its path or its name.** Hashes decide sameness
(`TextureImageStore.js`, `ImportDedupe.js`), paths only decide where to look again. Every bug this
folder has had came from somewhere treating a filename as an identity.
