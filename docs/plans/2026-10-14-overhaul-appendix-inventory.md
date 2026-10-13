# Appendix — function inventory and risk register

Companion to `docs/plans/2026-10-14-ux-asset-grouping-overhaul.md`. All paths are repo-relative; line numbers were read on master at 4da6236 (plan committed at 2a4c2a2). "Verdict" uses: **keep** · **merge** (fold into another surface) · **rename** · **move** · **remove**. "Should live" names the target surface from the main plan §2.5–2.6. Task ids (e.g. `5.3`) refer to the main plan §5.

## A. Function inventory (every user-reachable function)

### A1. Header / project / shell

| # | Function (en label) | Reachable now | Should live | Verdict |
|---|---|---|---|---|
| 1 | New project | header icon `src/ui/ProjectMenu.js:25` · Ctrl+N `src/app/main.ts:111` | header File group | keep |
| 2 | Open project | `src/ui/ProjectMenu.js:26` · Ctrl+O · empty-state `src/ui/ViewportEmptyState.js:27` · empty-space menu `src/ui/ContextMenu.js:176` | header + empty state | keep (4 entries OK: all beginner paths) |
| 3 | Save / Save As | `src/ui/ProjectMenu.js:27-28` · Ctrl+S / Ctrl+Shift+S | header | keep |
| 4 | Recent projects | `src/ui/ProjectMenu.js:30,149` | header (dropdown) | keep |
| 5 | Reset all settings | `src/ui/ProjectMenu.js:33,48-51` (no confirm) | under **?** menu with confirm | move (5.1) |
| 6 | Rename project (inline) | `src/ui/ProjectMenu.js:130-133` | header | keep |
| 7 | Language select | `src/ui/LocaleSwitcher.js:12` | header | keep |
| 8 | Workspace Layout/Shade/Scene/Print | pill `src/ui/Workspace.js:261-279` · Ctrl+Shift+1-4 `:106-115` | header pill | keep |
| 9 | Collapse right-panel section headers | `src/ui/AppShell.js:31-41` | right panel | keep |
| 10 | Splitters / collapse / expand (outliner, inspector, assets) | `src/ui/AppShell.js:72-202` | panel edges | keep; strings via i18n (0.1) |
| 11 | **Import model** (header) | none today | header primary button + Ctrl+I | **add** (5.1) |
| 12 | **Export** (header) | none today | header → Print ▸ Export | **add** (5.1) |
| 13 | **Undo / Redo buttons** | status text only `src/ui/StatusBar.js:14-31` | header icons + status bar buttons | **add** (0.9) |
| 14 | **Help / ? (shortcuts, tour, reset-all)** | none | header | **add** (5.5) |

### A2. Outliner

| # | Function | Reachable now | Should live | Verdict |
|---|---|---|---|---|
| 15 | Show internal parts toggle | `src/ui/Outliner.js:63,73` | Outliner header ("Show material parts") | rename (0.1) |
| 16 | Filter scene… | `src/ui/Outliner.js:67,80` | Outliner header + `file:` chip | keep, extend (3.4) |
| 17 | Select object row (Ctrl toggle, Shift add) | `src/ui/Outliner.js:703-709` | same | keep (viewport adopts same modifiers, 0.3) |
| 18 | Group row click → selects members | `src/ui/Outliner.js:710,717-732` | selects the **group** | **change** (2.1, 3.4) |
| 19 | Collection row click → selects members | `src/ui/Outliner.js:712,734-739` | removed (collections leave tree) | remove (3.4, Decision 2) |
| 20 | Part row click → selects lead | `src/ui/Outliner.js:313,541-545` | same | keep |
| 21 | Expand/collapse twirl + arrows | `src/ui/Outliner.js:244,366,558-562,697-699` | same | keep |
| 22 | Hide / Show (eye) | `src/ui/Outliner.js:389,552` | same; cascades on group rows | keep (2.5) |
| 23 | Lock / Unlock | `src/ui/Outliner.js:390,553` | same; enforced (2.5) | keep |
| 24 | Include/Exclude print (printer icon) | `src/ui/Outliner.js:373,554` | same, label "Print" | rename (0.1) |
| 25 | Repair via validation badge | `src/ui/Outliner.js:351-361,555` | same (label "Repair") | keep |
| 26 | Rename (dblclick / F2) | `src/ui/Outliner.js:567-573,694` | same | keep |
| 27 | Drag reparent / unparent | `src/ui/Outliner.js:589,653-684` | same; group-onto-group | keep |
| 28 | Drop shader onto row | `src/ui/Outliner.js:619-626,658-668` | same | keep |
| 29 | Row context menus (object/group/collection/part) | `src/ui/Outliner.js:575-587` | object/group only | keep; collection menu removed (3.5) |

### A3. Context menu (`src/ui/ContextMenu.js`)

| # | Function | Reachable now | Should live | Verdict |
|---|---|---|---|---|
| 30 | Select Members (collection) | `:151` | removed | remove (3.5) |
| 31 | Rename Collection… (window.prompt, direct setState) | `:152,587-601` | removed | remove (3.5) |
| 32 | Delete Collection (direct setState) | `:154,604-619` | removed | remove (3.5) |
| 33 | Select Members (group) | `:161,345` | **Select ▸** submenu | move (3.5) |
| 34 | Select Parent Group (group/object) | `:162,200,350` | Select ▸ | move |
| 35 | Unparent (group / object / duplicate at `:230`) | `:163,203,230,562` | primary tier, once | merge (0.3) |
| 36 | Reveal in Outliner | `:164,204` | Select ▸ | move |
| 37 | Import model… (empty space) | `:175` | keep + header | keep |
| 38 | Open project… (empty space) | `:176` | keep | keep |
| 39 | Frame all (empty space) | `:178` | keep; also Home key | keep |
| 40 | Cursor → World Origin (empty + object `:179,234`) | | **Cursor ▸** | move |
| 41 | Select Siblings | `:201,358` | Select ▸ | move |
| 42 | Select Import Members | `:202,367` | Select ▸ "Same file" | rename+move |
| 43 | Relink Asset… / Relink to live file… | `:207-209,495` | Properties ▸ Source + primary tier when missing | keep (4.6) |
| 44 | Focus (F) | `:212,501` | primary | keep |
| 45 | Toggle Hidden (H) | `:214,506` | primary "Hide/Show" | keep |
| 46 | Toggle Lock | `:215,516` | primary | keep |
| 47 | Rename… (window.prompt) | `:216,526` | primary → inline Outliner rename / Properties | merge (3.5: trigger Outliner inline rename instead of prompt) |
| 48 | Duplicate (Shift+D) | `:217` | primary | keep |
| 49 | Repair geometry | `:219,488` | primary "Repair" | rename |
| 50 | Export selected object(s)… | `:220` | primary | keep |
| 51 | Split to parts | `:223-224,466` | primary "Separate by material" | rename |
| 52 | Join into one object | `:225-226,478` | primary "Merge into one object" | rename |
| 53 | Group / Ungroup | `:228-229` | primary | keep (Ungroup acts on selected group, 2.4) |
| 54 | **Enter group / Exit group** | none | primary | **add** (3.5) |
| 55 | Selection → Cursor / Cursor → Selection | `:232-233` | Cursor ▸ | move |
| 56 | Drop to Bed / Center on Bed / Place Face on Bed | `:236-238,305-317` | **Arrange ▸** + Arrange panel | move |
| 57 | Smart Replace | `:240,372` | Combine ▸ "Replace with active" | rename+move |
| 58 | Transform Swab | `:241,389` | Combine ▸ "Copy placement from active" | rename+move |
| 59 | Align Center X/Y/Z | `:243-245,397` | Arrange ▸ Align ▸ | move |
| 60 | Combine: Union / Subtract / Intersect | `:247-249,434` | Combine ▸ | move |
| 61 | Slice & Connector… | `:250` | Combine ▸ | move |
| 62 | Mirror X/Y/Z | `:252-254,405` | Arrange ▸ Mirror ▸ | move |
| 63 | Array X/Y/Z (×3) | `:256-258,413` | Arrange ▸ Array ▸ (with count/spacing dialog) | move |
| 64 | Mate to Active | `:259,424` | Arrange ▸ "Snap to active" | rename+move |
| 65 | Delete | `:261,574` | primary (danger) | keep |

### A4. Properties (`src/ui/PropertiesPanel.js`)

| # | Function | Reachable now | Should live | Verdict |
|---|---|---|---|---|
| 66 | Name | `:151,164-170` | Object section (all workspaces) | keep |
| 67 | Visible / Locked toggles | `:154-155,175-178` | Object section | keep |
| 68 | ↧ Copy transform | `:207,367,380` | Transform header | keep |
| 69 | Ratio preset + text | `:264-268,276,335-344` | Transform "Scale ratio" | rename |
| 70 | Size (mm) X/Y/Z | `:216-218,352-356,411` | Transform | keep |
| 71 | Pos / Rot / Scale XYZ | `:222-236,346-350,445` | Transform | keep |
| 72 | Proportional scale lock | `:239,359-365` | Transform | keep |
| 73 | Source Unit select + Confirm | `:515-541` | Object ▸ "File units" + "Looks right" | rename (0.1) |
| 74 | Shader slot click → Library | `:657,671-676` | Material section (Shade) | keep |
| 75 | Duplicate in place / Replace… / Assign… | `:645-664,679-727` | Material section | keep |
| 76 | ↧ Copy shader | `:604,730,741` | Material header | keep |
| 77 | UV Override U/V/rotation + Reset + ↧ | `:822-848,856-892` | Material ▸ UV (Shade only, collapsed) | keep |
| 78 | Include in print export | `:930,940` | Object section "Print" toggle | rename |
| 79 | **Source status (Embedded / Linked / Changed / Missing) + Refresh / Find** | none | Object section | **add** (4.6) |
| 80 | Shader-picker modal | `:83,759-809` | same | keep |

### A5. Shader Library (`src/ui/ShaderPanel.js`) — rename "Materials"

| # | Function | Reachable now | Should live | Verdict |
|---|---|---|---|---|
| 81 | New shader (+) | `:302,362` | same | keep |
| 82 | Select row / duplicate icon / drag | `:324-328,369-397` | same | keep |
| 83 | Consolidate Duplicates | `:314,352-361` | same | keep |
| 84 | Editor: name/type/colour/hex | `:424-440,518-530` | same | keep |
| 85 | Texture drop / Pick… / Swap… / × | `:446-509,554-578,673` | same | keep |
| 86 | Opacity / Roughness / Metallic | `:453-465,532-534` | same | keep |
| 87 | UV base (U/V off, scale, Rot rad) | `:472-476,544-551` | same, "Rot (deg)" | rename (0.1) |
| 88 | Make Unique / Assign (n) / Select linked / Delete | `:480-483,583-610` | same; "Make Unique" tooltip | keep |
| 89 | Swatches + save swatch | `:696-718,727-751` | same; toast "Applied to N objects sharing this material" | keep (5.4) |
| 90 | Merge modal / Texture pick modal | `:75-76,136-257` | same | keep |
| 91 | Auto-focus on active change (passive) | `:73,81-93` | same | keep |

### A6. Scene panel (`src/ui/ScenePanel.js`)

| # | Function | Reachable now | Should live | Verdict |
|---|---|---|---|---|
| 92 | ↺ reset per section | `:217,565-570` | same | keep |
| 93 | Grid cell / subdivisions / Grid / Axes | `:264-272,574,587` | Scene ▸ Grid | keep |
| 94 | Background Light/Dark + levels | `:283-296,598,615` | Scene ▸ Environment | keep |
| 95 | HDRI toggle / preset / intensity | `:300-312,606` | Environment | keep |
| 96 | Grade: exposure/contrast/tone/saturation/vignette | `:317-342` | Environment ▸ Advanced disclosure | move inside disclosure (5.4) |
| 97 | Floor toggle/colour/Z/diameter | `:346-356,650-654` | Environment | keep |
| 98 | Shadows / key / fill / ambient / SSAO / AO | `:364-390` | Environment ▸ Advanced | move inside disclosure |
| 99 | Texture cap | `:398,659-663` | Environment ▸ Performance | keep |
| 100 | Reset environment | `:407,665-669` | same | keep |
| 101 | FOV / Near clip | `:413-417` | Scene ▸ Camera | keep |
| 102 | Cut view + axis/offset/flip | `:430-449,629-647` | Scene ▸ Cross Section; also viewport toggle | keep (+ toggle 5.7) |
| 103 | Still: resolution/size/transparent/Render view/Export PNG | `:459-483,677-724,803` · Ctrl+Alt+E `:155` | Scene ▸ Rendering | keep |
| 104 | Turntable: duration/fps/direction/ease/Preview/Export video | `:488-509,726-786` | Scene ▸ Rendering | keep |

### A7. Print panel (`src/ui/PrintPanel.js`, `src/ui/print/CostBlock.js`)

| # | Function | Reachable now | Should live | Verdict |
|---|---|---|---|---|
| 105 | Tabs Scale / Validation / Bed / Export | `PrintPanel.js:126,135-139` | **Printer / Validation / Export** (Scale folds into Export ▸ Advanced) | merge (1.3) |
| 106 | ↺ reset print settings | `:130,141` | Print header | keep |
| 107 | Target ratio pills / Add ratio… / custom | `:179-194,238-268` | Export ▸ Advanced "Other sizes" | move (1.3) |
| 108 | Validate All / Repair all (N) / Auto-Fix | `:416-417,448,464-506` | Validation ("Repair") | rename |
| 109 | Readiness card + issue routing | `:563,640-648,781` | strip on every tab + Export card | keep + extend (0.6) |
| 110 | Cost: material/price/support/setup/currency/volume basis/copy path | `CostBlock.js:116-162,180-210` | Export ▸ Cost card; plumbing behind ⚙ | keep (5.4) |
| 111 | Each individually | `PrintPanel.js:591,656` | Export ▸ Advanced | move |
| 112 | Bake solid colours (OBJ) | `:596,742` | Export ▸ Advanced (auto per printer) | move |
| 113 | Strict export | `:601,747` | Export ▸ Advanced (per-user) | move |
| 114 | Auto-repair on import | `:606,752` | **?** ▸ Preferences (per-user) | move (1.3) |
| 115 | Export OBJ / 3MF / STL | `:618-626,757-763` | Export: "Export for <printer>" primary + all formats | keep, re-layout (1.3) |
| 116 | **Export PLY / WRL (vertex colour)** | none | Export formats | **add** (1.6) |
| 117 | Build Volume Preset select | `:812,860` | Printer tab "Printer" | rename |
| 118 | Build Volume XYZ | `:829,877` | Printer tab | keep |
| 119 | Show bed volume | `:836,884` | Printer tab + viewport toggle | keep |
| 120 | **Split multi-material objects into parts (per-part colour printers)** | none | Export ▸ Advanced | **add** (1.5) |

### A8. Asset panel (`src/ui/AssetPanel.js`)

| # | Function | Reachable now | Should live | Verdict |
|---|---|---|---|---|
| 121 | Session / Library tabs | `:67-68,118-119` | **Project / Folders** | rename (4.6) |
| 122 | Mount / Refresh / Unmount | `:70-77,111-113,193,255,271` | Folders tab | keep |
| 123 | Smart views All/Used/Unused/Issues | `:290-296,551-572` | Project tab | keep |
| 124 | Folder tree row / expand | `:319-346,529-553` | Folders | keep |
| 125 | Search / scope / type filters | `:87-93,574-591` | same | keep |
| 126 | Remove asset × | `:498,594-599` | card menu | keep |
| 127 | Double-click → add to scene | `:601,634` | same | keep |
| 128 | Drag card to viewport / texture slot | `:508,616-622` | same | keep |
| 129 | Re-mount modal | `:136-150,207` | boot **banner** | move (4.7) |
| 130 | **Card menu: Add to scene / Reveal source / Refresh / Find moved / Remove** | none | Project tab | **add** (4.6) |
| 131 | **"Already in project" dedupe prompt** | none | import path | **add** (4.8) |

### A9. Viewport chrome

| # | Function | Reachable now | Should live | Verdict |
|---|---|---|---|---|
| 132 | Gizmo Move/Rotate/Scale | `src/ui/ViewportToolbar.js:22-24,99` | toolbar + W/E/R keys? (no — G/R/S stay modal) | keep |
| 133 | Pivot Active/Median/Cursor/World | `:28-31,100` · `.` cycles | toolbar ▸ dropdown | keep (collapse to dropdown, 5.6) |
| 134 | Local/World | `:73,102-105` · ` / ~ | toolbar | keep |
| 135 | Camera follow Free/Follow/Origin | `:35-37,101` | toolbar ▸ dropdown | keep |
| 136 | Display mode select (Shaded/Matte/Base/UV) | `src/ui/ViewportToggles.js:40-45,79` | toggles | keep |
| 137 | Wireframe edges + colour | `:46-51,80-99` | toggles | keep |
| 138 | Inverted faces | `:53,80-91` | toggles | keep |
| 139 | **Cross-section toggle / bed volume toggle in viewport** | Scene / Print panels only | toggles | **add** (5.7) |
| 140 | NavCube faces / drag / Home | `src/ui/NavCube.js:28-35,47-67,100-119` | same | keep |
| 141 | Empty-state Import / Open | `src/ui/ViewportEmptyState.js:26-27` | same | keep |
| 142 | Status-bar Fix | `src/ui/MeshStats.js:138-141` | same ("Repair") | rename |
| 143 | Cursor panel tab (Shift+N) | `src/ui/CursorPanel.js:41,56,68` | **Arrange** panel + toolbar button | rename (0.7) |
| 144 | **Scope breadcrumb** | none | under NavCube | **add** (3.3) |
| 145 | **Hover highlight** | none | viewport | **add** (5.6, Decision 22) |
| 146 | **Measure (two-point distance)** | none | toolbar | **add, optional** (7.x, Decision 23) |

### A10. Arrange (Cursor) panel (`src/ui/CursorPanel.js`)

| # | Function | Reachable now | Should live | Verdict |
|---|---|---|---|---|
| 147 | Cursor location XYZ / show / use as pivot | `:73-81,44-49,150-176` | Arrange ▸ Cursor sub-section | keep |
| 148 | Drop to Bed / Center on Bed | `:86-87,51-54,107` | Arrange | keep |
| 149 | Align Min/Center/Max XYZ | `:91-93` | Arrange | keep |
| 150 | Mirror XYZ / Array XYZ / Mate | `:96-98` | Arrange; Array gets count+spacing | keep (5.6) |

### A11. Slice & Connector (`src/ui/SliceConnectorSession.js`)

| # | Function | Reachable now | Verdict |
|---|---|---|---|
| 151 | Draw cut line / Cut / Part A-B / place / size / depth / clearance / Finish / Back / Cancel | `:299-338,358-372,390-473,476` | keep as is (Combine ▸ entry); unchanged by this plan |

### A12. Copy/paste, modals, toasts

| # | Function | Reachable now | Verdict |
|---|---|---|---|
| 152 | Ctrl+C / Ctrl+V aspect chooser | `src/ui/CopyPaste.js:40-84,120-165` | keep |
| 153 | Modals: exportSelected, booleanTextureBake, shader-picker, shaderMerge, texturePick, remountFolder, importError, validationErrors, exportGate, dirtyConfirm, recoverAutosave, unmatchedAssets, ghostAssets, portableSaveBlocked | `src/ui/ContextMenu.js:55,73` · `src/ui/PropertiesPanel.js:83` · `src/ui/ShaderPanel.js:75-76` · `src/ui/AssetPanel.js:136` · `src/ui/ImportError.js:16` · `src/ui/PrintPanel.js:79-80` · `src/ui/ProjectMenu.js:185,201,250-253` | remountFolder + recoverAutosave → boot banner (4.7); unmatched/ghost merge into one "Sources" modal (4.6); rest keep |
| 154 | Validation toasts (click → Validation tab / Auto-Fix) | `src/core/assets/AssetRegistration.js:282-300` | keep ("Repair") |
| 155 | Blocking progress overlay | `src/ui/ProgressOverlay.js:31-38,244-251` | add Cancel where abortable (5.8) |
| 156 | Close guard (beforeunload / Electron) | `src/app/main.ts:130-139` · `electron/main.cjs:34-38,106-114` | keep; guard Electron reload (0.4) |

### A13. Keyboard shortcuts (registered)

| Keys | Context | Registered at | Verdict |
|---|---|---|---|
| Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y | global | `src/core/InputManager.js:807-809` | keep |
| Ctrl+S / Ctrl+Shift+S / Ctrl+N / Ctrl+O | global | `src/app/main.ts:109-112` (no-op stubs `src/core/InputManager.js:811-814`) | keep; delete stubs (0.3) |
| G / R / S (+ X/Y/Z, Shift+axis, digits, Ctrl snap, Enter/Esc) | viewport | `src/core/InputManager.js:817-819,401-442` | keep |
| A / Alt+A | viewport | `:822-823` | keep |
| F | viewport | `:826` | keep; Home = frame all (add) |
| Numpad 0/1/3/5/7, Ctrl+Numpad, 2/4/6/8, Alt+1/3/7 | viewport | `:829-847` | keep |
| H / Alt+H | viewport | `:850-851` | keep |
| Ctrl+G / Ctrl+Shift+G | viewport | `:852-853` | keep |
| Shift+D | viewport | `:854` | keep |
| Delete / X | viewport | `:855-856` | keep |
| Tab (cycle panels — dead) | viewport | `:859` | remove (0.3) |
| ` / ~ | viewport | `:860-861` | keep |
| . | viewport | `:862` | keep |
| Ctrl+C / Ctrl+V | viewport | `src/ui/CopyPaste.js:40-41` | keep |
| Shift+N | global | `src/ui/CursorPanel.js:56` | keep (Arrange) |
| Ctrl+Alt+E | global | `src/ui/ScenePanel.js:155` | keep |
| Ctrl+Shift+1-4 | global | `src/ui/Workspace.js:106-115` | keep |
| N / T / \ | global | `src/ui/Workspace.js:117-119` | keep |
| **Ctrl+I import · Esc scope-out · Home frame-all · L lock** | none | add (0.3, 3.2) | **add** |
| F2 shown in menu but unregistered | — | `src/ui/ContextMenu.js:216` vs `src/ui/Outliner.js:694` | register globally (0.3) |

### A14. Mouse gestures

| Gesture | Code | Verdict |
|---|---|---|
| LMB click / Shift+LMB toggle / LMB-drag body / LMB-drag marquee | `src/core/InputManager.js:190-261` · `src/core/BoxSelect.js:89-123` | Shift→add, Ctrl→toggle (0.3); double-click enter (3.2) |
| RMB click → context menu; RMB drag orbit | `src/core/InputManager.js:176,183-186,282-297` · `src/core/scene/CameraRig.js:236-253` | keep |
| Shift+RMB → place cursor | `src/core/InputManager.js:172,299-315` | keep |
| MMB / Shift+MMB / wheel | `src/core/scene/CameraRig.js:151-154,250-253` | keep; add zoom-to-cursor option (5.6) |
| Gizmo drag / modal mouse move | `src/core/scene/PivotSession.js:66-67` · `src/core/InputManager.js:156,444` | keep; gizmo drags gain Ctrl-snap (5.6) |
| Drop from Asset panel / OS files / Import picker | `src/ui/ViewportDrop.js:42-49,98-199,59-84` | keep; stagger multi-file drops (5.6) |

### A15. Duplicates (3+ surfaces) and resolution

| Function | Surfaces today | Resolution |
|---|---|---|
| Visibility | Outliner eye · Properties · menu · H / Alt+H | keep all (cheap, consistent) |
| Lock | Outliner · Properties · menu | keep; add L key |
| Rename | Outliner inline/F2 · Properties · menu prompt | menu → triggers Outliner inline rename (no `window.prompt`) |
| Import | empty state · empty-space menu · OS drop · asset card · (new) header | keep all; header is the discoverable one |
| Repair | menu · badge · status Fix · Validation tab ×2 · toast · gate · on-import | keep surfaces, **one label "Repair"**, one implementation (`RepairSession`) |
| Pivot mode | toolbar ×4 · `.` · Cursor panel checkbox | toolbar dropdown + `.`; Cursor panel checkbox removed |
| Camera presets | NavCube · numpad · Alt+digit | keep |
| Placement verbs | menu · Cursor panel | menu **Arrange ▸** submenu + Arrange panel (same commands) |
| Shader assignment | Outliner drop · Properties ×3 · editor ×2 | keep |
| Workspace switch | pill · keys · 3 programmatic jumps | programmatic jumps get a toast with "back" (5.4) |
| Reset settings | header reset-all · Scene ↺ ×4 · Print ↺ · Reset environment | header reset-all moves under ? with confirm |
| Relink | menu · 3 modals | one `RelinkAssetCommand` + one Sources modal + Properties ▸ Source |
| Export | Print tab ×3 · menu Export selected · (new) header | keep |

---

## B. Risk register

Likelihood/impact: L/M/H. "Closes" = main-plan task id. Mitigation citations were verified by reading the files.

### B1. Data loss

| ID | Risk | L | I | Existing mitigation | Gap | Closes |
|---|---|---|---|---|---|---|
| R1 | Torn / partial `.mixo` on save | L | H | FSA `createWritable→write→close` commits atomically (`src/core/PersistenceManager.js:56-60`); saveAs writes before binding (`:94-98`); open binds after load (`:138-142`) | no `w.abort()` on failure (`:56-60`, `src/core/print/Download.js:18-20`); no read-back verify; `pushRecent` throw after bytes written rejects `save()` with dirty already cleared (`:65-74`) | 0.2 |
| R2 | Autosave never offered back | **H** | **H** | written every 60 s while dirty (`src/core/persist/Autosave.js:15-43`); recovery function + modal exist (`:53-88`, `src/ui/ProjectMenu.js:201`) | **no caller anywhere** (`src/app/main.ts:118-120` only starts the timer); keyed by `project.name` so same-named projects clobber each other (`Autosave.js:29`, `src/core/persist/ProjectLoader.js:465-468`); single `isLoading/isImporting` check before an async build (`Autosave.js:26-28`) | 0.11, 4.7 |
| R3 | Schema drift / version refusal | M | M | `ProjectValidator` refuses newer major (`src/core/persist/ProjectValidator.js:49-77`) before `resetWorld` (`ProjectLoader.js:172-174`) | `migrate()` is identity (`ProjectLoader.js:121-126`); newer-minor loads silently and drops unknown fields on re-save; `StateManager.js:7` still defaults `project.version` to `'3.1'` | 4.1 |
| R4 | Browser storage eviction (IDB handles, autosave, recents vanish) | M | H | tiered fallback to embedded bytes (`src/core/persist/AssetResolver.js:45-96`); ghosts stay relinkable (`src/core/persist/ProjectSerializer.js:110-115`) | no `navigator.storage.persist()` anywhere; autosave omits bytes for handle-backed assets (`ProjectSerializer.js:130-133`) so a post-eviction recovery ghosts them; stale `recent_*` handle keys never pruned (`src/core/persist/RecentProjects.js:23-24`) | 0.2, 4.7 |
| R5 | Electron refs lost / KV corruption | H (today) | M | KV temp+rename, serialised, quarantine (`electron/KvStore.cjs:32-83`) | mount refs are session tokens (`electron/OpaqueFileRegistry.cjs:15-24`; `src/core/assets/DirMounts.js:20,30`) → every desktop folder asset degrades after restart; registry grows unbounded (`OpaqueFileRegistry.cjs:43`); no fsync | 4.2, 4.9 |
| R6 | Close / reload without save | M | H | web `beforeunload` when dirty (`src/app/main.ts:130-134`); Electron close intercept + renderer answer (`electron/main.cjs:34-38,106-114`; `src/core/PersistenceManager.js:189-196`) | `beforeunload` skipped under Electron (`main.ts:131`) → Ctrl+R unguarded; no `render-process-gone` handler; `MIXO_SMOKE` bypass (`main.cjs:35`) | 0.4 |
| R7 | Load/import interleave | L | M | `LoadGate` (`src/core/persist/LoadGate.js:5-15`); checks at `ProjectLoader.js:162-180`, `src/core/assets/AssetImport.js:89-90,173,308` | `loadFromBlob` awaits hashing/siblings **before** `_importBegin` (`AssetImport.js:173-187`) → a load can start in that window; `open()/openRecent` don't call `assertNoImportInFlight` before the dirty confirm | 0.5 |
| R8 | Crash mid-export / partial file | L | M | zip built in memory first (`src/core/print/PrintPackaging.js:49-54`); FSA commit on close; clones disposed in `finally` (`src/core/print/PrintPipeline.js:571-572`); cancel never toasts success (`src/core/print/Download.js:22-24`) | non-Abort FSA error silently falls to anchor download (`Download.js:22-25`); no `abort()`; no size guard | 0.2 |
| R9 | Direct-to-disk overwrite without consent | L | M | OS save dialog confirms overwrite (`Download.js:14-20`) | future "export again" via remembered ref would bypass it — rule in 1.3: every disk write of a new file goes through a dialog or an explicit "Replace" confirm | 1.3 |

### B2. Fidelity

| ID | Risk | L | I | Existing mitigation | Gap | Closes |
|---|---|---|---|---|---|---|
| F1 | Texture downscaled into the export | L | H | full-res PNG captured before cap (`src/core/assets/TextureCap.js:44-79`); export prefers frozen source (`src/core/print/ExportTextures.js:25-29`); cap default 0 (`src/config/default-settings.json:29`) | capture failure swallowed (`TextureCap.js:76-78`) → silently falls to GPU readback of the capped copy; no dedicated test for `TextureCap.js` | 0.8 |
| F2 | Colour-space errors (sRGB vs linear) | L | M | one seam `src/core/shaders/ColorSpace.js:14-42` used by `ObjWriter.js:165`, `ThreeMFWriter.js:46`, `BooleanService.js:166`, `ShaderLibrary.js:54,68` | texture PNG bytes exported as-read with no sRGB flag check (`ExportTextures.js`); no direct test of `ColorSpace.js` | 1.9 |
| F3 | UV loss in Boolean | L | H | gate blocks textured operands unless baked (`src/core/commands/BooleanCommands.js:23,50-52`; ADR 0002) | gate checks diffuse/albedo/emissive only; `computeBoolean` itself unguarded | 6.3 |
| F4 | Unit / axis errors | M | H | one import seam (`src/core/ImportNormalizer.js`), one axis seam (`src/core/print/PrintSpace.js:25-31`), 3MF unit attr (`src/core/ThreeMFLoader.js:201-204`), `unit-unconfirmed` warning (`src/core/print/PrintReadiness.js:46`) | **OBJ writer bypasses PrintSpace** (`src/core/print/ObjWriter.js:235,241`, Y-up with x negated — unverified in Mimaki tool); `SOURCE_UNIT_FACTORS` lacks micron (`src/core/scale/ScaleMath.js:6-12`) | 1.7 |
| F5 | Shared vertex buffer double-bake | L | H | `_unshareVertexBuffers` (`ImportNormalizer.js:90-103,173`) | detection only within one container | — (accepted) |
| F6 | Repair replay failure on load | M | M | per-object fault isolation (`ProjectLoader.js:362-368`); export re-repairs clones | failed replay keeps `geometryFixes` listed, console-only (`ProjectLoader.js:359-361`) → scene silently unrepaired | 0.5 |
| F7 | Multi-material object merged into one 3MF mesh | H | M (per-part printers) | — | `ThreeMFWriter.js:272` concatenates parts with per-triangle pindex; Bambu/Prusa need separate parts | 1.5 |

### B3. Performance

| ID | Risk | L | I | Existing mitigation | Gap | Closes |
|---|---|---|---|---|---|---|
| P1 | Heavy textures + high-poly tab death | M | H | triangle budget warn (`src/core/storage/capabilities.js:33-34`, `src/core/assets/AssetImport.js:149-157`); validation worker (`src/core/MeshValidator.js:115-122`); adaptive DPR (`src/core/scene/AdaptiveResolution.js:20-25`); outline gating (`src/core/scene/SelectionOutline.js:212-226,309`); OBJ worker + 120 s timeout (`src/core/WorkerImport.js:17,74-104`); auto-validate skip >100k verts (`MeshValidator.js:17,527-529`); texture cap (`TextureCap.js`) | validation worker has no timeout; budget advisory only; no import file-size cap | 6.4 |
| P2 | Hash scan on load | H | M | cap 4000 files per scan (`src/core/persist/constants.js:15`, `AssetResolver.js:18-35`) | per-asset fresh budget → N×4000 full reads, serial, main thread | 4.3 (explicit Find) |
| P3 | Autosave cost | H | M | `skipEmbed` for handle-backed assets (`ProjectSerializer.js:132`); base64 in worker | `textureImages` always re-encoded (`ProjectSerializer.js:166-178`); loose drops embedded every tick | 0.11 |

### B4. Wrong print

| ID | Risk | L | I | Existing mitigation | Gap | Closes |
|---|---|---|---|---|---|---|
| W1 | Wrong scale | M | H | per-object ratio + factor (`src/core/print/ExportContext.js:123,140-142`); `unit="millimeter"` (`src/core/print/ThreeMFWriter.js:244,401`); readiness size preview (`PrintReadiness.js:70-76`); filename ratio suffix | `unit-unconfirmed` is acknowledge-only; acknowledgement enforced in UI (`src/ui/PrintPanel.js:684`) not pipeline (`PrintPipeline.js:317`); no absurd-size sanity check | 1.3, 1.8 |
| W2 | Inside-out faces | L | H | flag-aware validator (`MeshValidator.js:92-106,445`); `printIndices` (`PrintSpace.js:63-74`); repair conforms winding (`src/core/repair/MeshRepair.js:388-401`) | `invertedNormals` is warning-only (`MeshValidator.js:221`) → never blocks; heuristic for open meshes | 1.8 |
| W3 | Non-watertight export | M | H | repair on clones (`PrintPipeline.js:466-476,486`); `strictExport` (`:525-533`); validator crash blocks (`:268-274`) | strict off by default; unknown verdict (engine missing / >300k) never blocks even in strict; multi-part units skip CSG re-bake (`:500-514`) | 1.8 |
| W4 | Bed overflow / below bed | M | M | `BedFit` (`src/core/print/BedFit.js:22-39`); readiness (`PrintReadiness.js:70-84`) | warnings only; custom printer with null bed → no check | 1.2 |
| W5 | Missing texture at export | L | H | fails closed (`ExportTextures.js:35-43,110,176`); readiness `missing-texture` error (`PrintReadiness.js:45`) | only diffuse slot exported (`ExportTextures.js:99-101`) | 1.9 |
| W6 | Package name collisions | M | H | `uniqueEntryPaths` case-insensitive `_2` (`PrintPackaging.js:72-89`); `textureExportFilename` `_1` (`ExportTextures.js:72-84`) | texture `usedNames` is **case-sensitive** (`ExportTextures.js:78`) → `A.png`/`a.png` collide at zip level and the XML/MTL reference then points at the wrong image | 0.10, 4.8 |
| W7 | Printer-specific limits unchecked (texture size, wall thickness, format flavour) | H | H | — | printers.json carries bed only (`src/config/printers.json:2-91`); `minWallThickness`/`printMode`/`chordTolerance` dead (`src/config/default-settings.json:39-49`) | 1.1–1.6 |

### B5. Security

| ID | Risk | L | I | Existing mitigation | Gap | Closes |
|---|---|---|---|---|---|---|
| S1 | Malicious / huge input files | M | M | 3MF: XML reject, unit allowlist, finite + index checks, cycle check (`src/core/ThreeMFLoader.js:85-88,201-204,325-327,352,459,482`); OBJ worker timeout + payload shape (`WorkerImport.js:17,203-223`); extension allowlist (`src/core/assets/AssetTypes.js:1`, `AssetImport.js:174-176`) | no file-size cap; `JSZip.loadAsync` without entry/size limits (`ThreeMFLoader.js:534`) → zip bomb; glTF/OBJ parsing delegated to Babylon (unaudited) | 6.4 |
| S2 | Electron hardening | M | H | `contextIsolation:true`, `nodeIntegration:false` (`electron/main.cjs:25-29`); narrow preload (`electron/preload.cjs:10-40`); opaque refs reject unknown (`electron/OpaqueFileRegistry.cjs:44-45`); path IPC removed (`main.cjs:103`) | `sandbox:false` (`main.cjs:28`); no CSP (inline scripts `index.html:22,123`); no `will-navigate` / `setWindowOpenHandler`; `dialog:open/save` pass renderer options through and return OS paths (`main.cjs:104-105`) | 6.1, 6.2 |
| S3 | HTML injection from file names | L | M | `src/ui/renderSafe.js` escapers used at every found site (`Outliner.js:257,319,388`, `AssetPanel.js:364`, `ShaderPanel.js:175,249,326`, `PropertiesPanel.js:151,655,783`, `ProjectMenu.js:152,231,290`, `ImportError.js:62-68`, `PrintPanel.js:446,1010`) | heuristic review; `ShaderPanel.js:224,246` builds CSS selectors via `_cssId` (unread); no escaping test | 6.5 |

### B6. Maintenance

| ID | Risk | L | I | Existing mitigation | Gap | Closes |
|---|---|---|---|---|---|---|
| M1 | Web/desktop divergence | H | M | adapter + caps model (`src/core/storage/*`) | direct FSA at `PersistenceManager.js:57,88,124,177`, `ProjectLoader.js:494`, `Download.js:9,14,18`, `ViewportDrop.js:62`, `AssetPanel.js:225`; direct idb imports in 6 modules; 4 caps never read; `main.ts:41` hard gate | 4.2, 4.4 |
| M2 | Test coverage gaps | M | M | 80 headless files + 5 smokes | no dedicated test for 50+ modules incl. `PivotSession`, `ParentCommands`, `TransformCommands`, `CameraRig`, `TextureCap`, `AssetResolver`, `ProjectValidator`, `PrintPackaging`, `ColorSpace`, `ViewportDrop`, `ProjectMenu` (list in agent audit; smoke-only: workers, CSG, WASM repair, Electron close) | 6.6 |
| M3 | Blueprint drift | M | M | AGENTS rule "Blueprint update same turn" | ~35 files absent from §0.3 (e.g. `LogicalObjects.js`, `LoadGate.js`, `storage/*`, `ColorSpace.js`, `CopyPaste.js`, electron/*) | 6.7 |
| M4 | Dead code / dead settings | M | L | — | `restoreDirectory`, `recoverAutosave` (unreachable), `pickOpen/pickSave`, `ExportPlanner.buildExportPlan`, `PrinterProfiles.*` helpers, `src/export/ExportPipeline.ts`, `src/import/ImportPipeline.ts`, `src/core/printers/PrinterProfile.ts`, dead print keys | 1.10, 4.9 |
