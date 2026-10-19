// Babylon's ExtrasAsMetadata copies node extras, but not mesh primitive extras.
// This loader hook captures the primitive payload while its glTF identity and
// Babylon mesh are both available. Normalisation waits until geometry loads.
import { GLTFLoader } from '@babylonjs/loaders/glTF/2.0/glTFLoader.js';

const EXTENSION_NAME = 'MixoPrimitiveExtras';

class MixoPrimitiveExtras {
  constructor(loader) {
    this.name = EXTENSION_NAME;
    this.enabled = true;
    this._loader = loader;
  }

  dispose() {
    this._loader = null;
  }

  _loadMeshPrimitiveAsync(context, name, node, mesh, primitive, assign) {
    if (!Object.hasOwn(primitive.extras ?? {}, 'mixo_print_refinement')) return null;
    return this._loader._loadMeshPrimitiveAsync(context, name, node, mesh, primitive, babylonMesh => {
      babylonMesh.metadata = {
        ...(babylonMesh.metadata ?? {}),
        mixoPrimitiveId: `gltf:${mesh.index}:primitive:${primitive.index}`,
        mixoPrimitiveRefinement: primitive.extras.mixo_print_refinement,
      };
      assign(babylonMesh);
    });
  }
}

GLTFLoader.RegisterExtension(EXTENSION_NAME, loader => new MixoPrimitiveExtras(loader));
