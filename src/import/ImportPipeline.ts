import type { AuthoredScale } from '../core/scale/ScaleMath';

export type SourceFileRead = {
  fileName: string;
  extension: '.glb' | '.gltf' | '.obj' | '.stl' | '.3mf';
  blob: Blob;
  bytesHash: string;
  directoryHandleKey?: string;
  fileHandleKey?: string;
};

export type ImportedTexture = {
  id: string;
  name: string;
  mimeType: string;
  width: number;
  height: number;
};

export type RawImportedAsset<TContainer = unknown> = {
  assetId: string;
  container: TContainer;
  embeddedTextures: ImportedTexture[];
  authoredScale: AuthoredScale;
};

export type NormalizedImport<TMesh = unknown> = {
  assetId: string;
  meshes: TMesh[];
  authoredScale: AuthoredScale;
  collectionName: string;
};

export type AssetEntry = {
  id: string;
  name: string;
  fileName: string;
  extension: string;
  authoredScale: AuthoredScale;
  originalPath?: string;
  contentHash?: string;
  thumbnailDataUrl?: string;
};

export type CollectionEntry = {
  id: string;
  name: string;
  sourceAssetId: string;
  rootPartIds: string[];
};

export type ScenePartEntry = {
  id: string;
  name: string;
  assetId: string;
  collectionId: string;
  sourceGroupId?: string;
  shaderId?: string;
  printable: boolean;
  visible: boolean;
  locked: boolean;
};
