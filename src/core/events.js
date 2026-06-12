export const EVENTS = {
  // Asset lifecycle
  ASSET_REGISTERED:        'asset:registered',
  ASSET_REMOVED:           'asset:removed',
  ASSET_INSTANTIATED:      'asset:instantiated',
  ASSET_MISSING:           'asset:missing',
  ASSET_RELINKED:          'asset:relinked',

  // Scene object lifecycle (structural changes to state.scene.objects)
  OBJECT_REMOVED:          'object:removed',
  OBJECT_RESTORED:         'object:restored',
  OBJECT_UPDATED:          'object:updated',

  // Validation
  VALIDATION_STARTED:      'validation:started',
  VALIDATION_COMPLETE:     'validation:complete',
  VALIDATION_FOCUS_REQUESTED: 'validation:focusRequested', // toast click-through → Print Panel Validation tab (B5)

  // Selection
  SELECTION_CHANGED:       'selection:changed',
  ACTIVE_OBJECT_CHANGED:   'selection:activeChanged',

  // Transform
  TRANSFORM_COMMITTED:     'transform:committed',

  // Shaders
  SHADER_CREATED:          'shader:created',
  SHADER_UPDATED:          'shader:updated',
  SHADER_DUPLICATED:       'shader:duplicated',
  SHADER_ASSIGNED:         'shader:assigned',
  UV_OVERRIDE_CHANGED:     'shader:uvOverrideChanged',
  COLOR_APPLIED:           'shader:colorApplied',

  // Hierarchy
  GROUP_CREATED:           'hierarchy:groupCreated',
  GROUP_DISSOLVED:         'hierarchy:groupDissolved',
  PARENT_CHANGED:          'hierarchy:parentChanged',
  OBJECT_RENAMED:          'hierarchy:renamed',
  VISIBILITY_CHANGED:      'hierarchy:visibilityChanged',
  LOCK_CHANGED:            'hierarchy:lockChanged',

  // Collections (file-import display buckets in the outliner)
  COLLECTION_CREATED:      'collection:created',
  COLLECTION_REMOVED:      'collection:removed',
  COLLECTION_RENAMED:      'collection:renamed',
  COLLECTION_MEMBERSHIP:   'collection:membership',

  // History
  HISTORY_PUSHED:          'history:pushed',
  HISTORY_UNDONE:          'history:undone',
  HISTORY_REDONE:          'history:redone',

  // Print
  EXPORT_STARTED:          'print:exportStarted',
  EXPORT_COMPLETE:         'print:exportComplete',

  // Project
  PROJECT_NEW:             'project:new',
  PROJECT_LOADED:          'project:loaded',
  PROJECT_SAVED:           'project:saved',
  PROJECT_DIRTY:           'project:dirty',
  PROJECT_RENAMED:         'project:renamed',
  AUTOSAVE_WRITTEN:        'project:autosaved',

  // Camera
  CAMERA_PRESET_CHANGED:   'camera:presetChanged',

  // Workspaces (PART 13b)
  WORKSPACE_CHANGED:       'ui:workspaceChanged',
  PANEL_COLLAPSED_CHANGED: 'ui:panelCollapsedChanged',

  // UI
  TOAST:                   'ui:toast',
  MODAL_OPEN:              'ui:modalOpen',
  MODAL_CLOSE:             'ui:modalClose',
  UI_PANEL_CHANGED:        'ui:panelChanged',
  UI_CONTEXT_MENU:         'ui:contextMenu',
};
