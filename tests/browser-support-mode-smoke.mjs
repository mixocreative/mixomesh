// Support Mode (plan 2026-10-29 P3.2) on the real app: isolation mask, dimmed + inert panels, every
// shadowed key and pointer path inert, Esc order, mode-scoped undo, exit restores everything, and a
// save and an export taken DURING the mode contain all three objects.
//
//   node tests/browser-support-mode-smoke.mjs        (vite dev server + headless Chrome)
//   SHOT=<dir> node tests/browser-support-mode-smoke.mjs   also writes a screenshot of the mode

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assert, launchApp, sleep } from './cdp-harness.mjs';

const SHOT = process.env.SHOT ? resolve(process.env.SHOT) : null;
const FILES = ['support-plain-cube.glb', 'support-cube-overhang.glb', 'support-seam-cube.glb'];
const ISOLATION_LAYER = 0x10000000;

const KEYS = {
  G: { key: 'g', code: 'KeyG', vk: 71 }, R: { key: 'r', code: 'KeyR', vk: 82 }, S: { key: 's', code: 'KeyS', vk: 83 },
  X: { key: 'x', code: 'KeyX', vk: 88 }, Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  H: { key: 'h', code: 'KeyH', vk: 72 }, A: { key: 'a', code: 'KeyA', vk: 65 }, L: { key: 'l', code: 'KeyL', vk: 76 },
  F2: { key: 'F2', code: 'F2', vk: 113 }, Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 }, ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  C: { key: 'c', code: 'KeyC', vk: 67 }, V: { key: 'v', code: 'KeyV', vk: 86 }, D: { key: 'd', code: 'KeyD', vk: 68 },
  N: { key: 'n', code: 'KeyN', vk: 78 }, Gk: { key: 'g', code: 'KeyG', vk: 71 }, Z: { key: 'z', code: 'KeyZ', vk: 90 },
  Y: { key: 'y', code: 'KeyY', vk: 89 }, I: { key: 'i', code: 'KeyI', vk: 73 },
};
const MOD = { alt: 1, ctrl: 2, shift: 8 };

/** [label, key, modifiers]: each must do something outside the mode and nothing inside it. */
const SHADOWED = [
  ['G', 'G', []], ['R', 'R', []], ['S', 'S', []], ['X', 'X', []], ['Delete', 'Delete', []], ['H', 'H', []],
  ['A', 'A', []], ['Alt+H', 'H', ['alt']], ['L', 'L', []], ['F2', 'F2', []], ['Shift+D', 'D', ['shift']],
  ['Ctrl+G', 'Gk', ['ctrl']], ['Shift+N', 'N', ['shift']], ['Ctrl+C', 'C', ['ctrl']], ['Ctrl+V', 'V', ['ctrl']],
  ['Ctrl+I', 'I', ['ctrl']], ['ArrowLeft', 'ArrowLeft', []], ['Shift+ArrowUp', 'ArrowUp', ['shift']],
];

async function main() {
  const app = await launchApp({ prefix: 'mixomesh-support-mode-' });
  const { cdp, run } = app;
  const failures = [];
  const check = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); };
  try {
    await run(`(() => { try { localStorage.setItem('mx-onboard-v1', '1'); } catch {} document.querySelector('.ob-skip')?.click(); })()`);

    const press = async (name, mods = []) => {
      const k = KEYS[name];
      const modifiers = mods.reduce((n, m) => n | MOD[m], 0);
      const ev = { modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
      const printable = k.key.length === 1 && !(modifiers & (MOD.ctrl | MOD.alt));
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...(printable ? { text: mods.includes('shift') ? k.key.toUpperCase() : k.key } : {}), ...ev });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
      await sleep(60);
    };
    const mouse = async (type, x, y, extra = {}) => {
      await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
    };

    // ── Three objects, apart from each other ──
    const ids = [];
    for (const [i, file] of FILES.entries()) {
      const res = await run(`(async () => {
        const { AssetLoader } = await import('/src/core/AssetLoader.js');
        const blob = await (await fetch('/tests/fixtures/${file}')).blob();
        const meshIds = await AssetLoader.loadFromBlob(blob, '${file}');
        await new Promise(r => setTimeout(r, 700));
        const mesh = AssetLoader.getBabylonMesh(meshIds[0]);
        mesh.position.x = ${(i - 1) * 0.06};
        mesh.computeWorldMatrix(true);
        return meshIds[0];
      })()`);
      ids.push(res);
    }
    const [a, b, c] = ids;
    assert(a && b && c, 'three objects imported');
    await run(`(async () => { const { SceneManager } = await import('/src/core/SceneManager.js'); SceneManager.frameAll?.(); })()`);
    await sleep(800);

    const probe = (idsJson = JSON.stringify(ids)) => `(async () => {
      const { getState } = await import('/src/core/StateManager.js');
      const { AssetLoader } = await import('/src/core/AssetLoader.js');
      const { InputManager } = await import('/src/core/InputManager.js');
      const { HistoryManager } = await import('/src/core/HistoryManager.js');
      const s = getState();
      const meshes = {};
      for (const id of ${idsJson}) {
        const m = AssetLoader.getBabylonMesh(id);
        meshes[id] = { p: m.position.asArray(), r: m.rotationQuaternion?.asArray() ?? m.rotation.asArray(), sc: m.scaling.asArray(), mask: m.layerMask, enabled: m.isEnabled(), vis: m.isVisible };
      }
      const cursor = document.querySelector('#cursor-panel');
      return JSON.stringify({
        objects: Object.fromEntries(Object.entries(s.scene.objects).map(([k, o]) => [k, { visible: o.visible, locked: o.locked, name: o.name }])),
        selection: s.selection.selectedIds, active: s.selection.activeId,
        meshes: Object.fromEntries(Object.entries(meshes).map(([k, v]) => [k, { p: v.p, r: v.r, sc: v.sc, enabled: v.enabled, vis: v.vis }])),
        masks: Object.fromEntries(Object.entries(meshes).map(([k, v]) => [k, v.mask])),
        undo: HistoryManager.getUndoLabel(), modal: InputManager.isModalActive(),
        cursorOpen: !!cursor && !cursor.classList.contains('hidden') && getComputedStyle(cursor).display !== 'none',
        ctxMenu: !!document.querySelector('.context-menu:not(.hidden)'),
        nodes: Object.keys(s.scene.objects).length,
      });
    })()`;
    const snap = async () => JSON.parse(await run(probe()));
    const stable = (s) => JSON.stringify({ ...s, masks: undefined });
    const select = (list, active = list[0]) => run(`(async () => { const { Selection } = await import('/src/core/Selection.js'); ${list.length ? `Selection.set(${JSON.stringify(list)}, ${JSON.stringify(active)})` : 'Selection.clear()'}; })()`);
    const modeInfo = () => run(`(async () => {
      const { supportMode } = await import('/src/supports/SupportMode.ts');
      const btn = document.querySelector('#support-mode-enter');
      const inertSel = ['#outliner', '#right-panel', '#asset-panel', '#viewport-toolbar', '.ws-switcher'];
      return JSON.stringify({
        active: supportMode.isActive(), ids: supportMode.getObjectIds(),
        dataMode: document.getElementById('app').dataset.mode ?? null,
        inert: inertSel.map(s => document.querySelector(s)?.inert),
        opacity: inertSel.map(s => Number(getComputedStyle(document.querySelector(s)).opacity)),
        label: document.querySelector('#support-mode-label')?.textContent ?? null,
        done: !!document.querySelector('#support-mode-done'),
        enterExists: !!btn, enterDisabled: btn?.disabled ?? null,
        mode: (await import('/src/core/InputManager.js')).InputManager.getMode(),
        toasts: [...document.querySelectorAll('.mx-toast-msg')].map(e => e.textContent),
      });
    })()`).then(JSON.parse);

    // ── Header button: disabled with nothing selected, enabled with a selection ──
    await select([]);
    await sleep(150);
    let info = await modeInfo();
    check(info.enterExists && info.enterDisabled === true, 'header "Supports" button exists and is disabled with nothing selected');
    await press('S', ['shift']);
    info = await modeInfo();
    check(!info.active, 'Shift+S with nothing selected does not enter the mode');
    check(info.toasts.length === 1, 'Shift+S with nothing selected says why (kit toast)');

    // ── Controls: the shadowed keys DO act outside the mode ──
    await select([a, b], a);
    await sleep(150);
    info = await modeInfo();
    check(info.enterDisabled === false, 'header button enabled with 2 objects selected');
    const wsBtn = await run(`(() => { const e = document.querySelector('#support-mode-root'); const p = document.querySelector('.ws-switcher'); return !!e && !!p && p.nextElementSibling === e; })()`);
    check(wsBtn, 'entry sits right after the workspace tabs');
    const control = await snap();
    await press('G');
    check((await snap()).modal === true, 'control: G starts a grab modal outside the mode');
    await press('Escape');
    check((await snap()).modal === false, 'control: Esc cancels it');
    await press('H');
    check(JSON.stringify((await snap()).objects) !== JSON.stringify(control.objects), 'control: H hides the selection outside the mode');
    await press('H', ['alt']);
    check(JSON.stringify((await snap()).objects) === JSON.stringify(control.objects), 'control: Alt+H restores it');

    // ── A non-support history step older than the mode, then enter with Shift+S ──
    await run(`(async () => {
      const { HistoryManager } = await import('/src/core/HistoryManager.js');
      window.__pre = [];
      HistoryManager.push({ label: 'pre-mode step', execute() { window.__pre.push('do'); }, undo() { window.__pre.push('undo'); } });
    })()`);
    const before = await snap();
    await press('S', ['shift']);
    await sleep(300);
    info = await modeInfo();
    check(info.active && info.ids.length === 2 && info.ids.includes(a) && info.ids.includes(b), 'Shift+S enters the mode on the 2 selected objects');
    check(info.dataMode === 'supports', 'shell has data-mode="supports"');
    check(info.mode === 'supports', 'InputManager mode context is supports');
    check(info.label === 'Support Mode — 2 objects', `header label reads "${info.label}"`);
    check(info.done, 'Done button shown');
    check(info.inert.every(v => v === true), `every unused panel is inert ${JSON.stringify(info.inert)}`);
    check(info.opacity.every(v => v < 0.6), `every unused panel is dimmed ${JSON.stringify(info.opacity)}`);

    const inMode = await snap();
    check(inMode.masks[c] === ISOLATION_LAYER, 'the unselected third object is masked');
    check(inMode.masks[a] !== ISOLATION_LAYER && inMode.masks[b] !== ISOLATION_LAYER, 'selected objects are not masked');
    check(JSON.stringify(inMode.objects) === JSON.stringify(before.objects), 'object visibility state is untouched (mask is not visibility)');
    check(inMode.meshes[c].enabled && inMode.meshes[c].vis, 'the third mesh stays enabled and isVisible (nothing for exports to skip)');
    check(inMode.undo === before.undo, 'entering the mode adds no undo step');

    // Frame the camera on the two objects, then verify the third is not drawn: a pick ray through it misses.
    const hidden = await run(`(async () => {
      const { SceneManager } = await import('/src/core/SceneManager.js');
      const { AssetLoader } = await import('/src/core/AssetLoader.js');
      const scene = SceneManager.getScene();
      const draw = (id) => { const m = AssetLoader.getBabylonMesh(id); return scene.activeCamera && (scene.activeCamera.layerMask & m.layerMask) !== 0; };
      return JSON.stringify({ a: draw(${JSON.stringify(a)}), b: draw(${JSON.stringify(b)}), c: draw(${JSON.stringify(c)}) });
    })()`).then(JSON.parse);
    check(hidden.a && hidden.b && !hidden.c, `camera draws a and b, not c ${JSON.stringify(hidden)}`);

    // ── Shadowed keys are inert ──
    const base = stable(await snap());
    for (const [label, name, mods] of SHADOWED) {
      await press(name, mods);
      const still = (await modeInfo()).active;
      if (!still) { await select([a, b], a); await press('S', ['shift']); await sleep(200); }
      const now = stable(await snap());
      check(now === base && still, `${label} is inert inside the mode`);
    }

    // ── Pointer paths are inert: body drag, marquee, click on empty, context menu ──
    const pt = await run(`(async () => {
      const { SceneManager } = await import('/src/core/SceneManager.js');
      const { AssetLoader } = await import('/src/core/AssetLoader.js');
      const scene = SceneManager.getScene(); const cam = scene.activeCamera; const eng = scene.getEngine();
      const canvas = document.querySelector('#renderCanvas'); const rect = canvas.getBoundingClientRect();
      const m = AssetLoader.getBabylonMesh(${JSON.stringify(a)}); m.computeWorldMatrix(true);
      const c = m.getBoundingInfo().boundingBox.centerWorld;
      const p = BABYLON.Vector3.Project(c, BABYLON.Matrix.IdentityReadOnly, scene.getTransformMatrix(), cam.viewport.toGlobal(eng.getRenderWidth(), eng.getRenderHeight()));
      const k = canvas.width / rect.width;
      return JSON.stringify({ x: rect.left + p.x / k, y: rect.top + p.y / k, left: rect.left + 30, bottom: rect.bottom - 30 });
    })()`).then(JSON.parse);
    const dragFrom = async (x, y, dx = 120, dy = 50) => {
      await mouse('mouseMoved', x, y, { buttons: 0 });
      await mouse('mousePressed', x, y);
      for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', x + dx * i / 6, y + dy * i / 6); await sleep(30); }
      await mouse('mouseReleased', x + dx, y + dy);
      await sleep(150);
    };
    await dragFrom(pt.x, pt.y);                       // body drag on a selected object
    check(stable(await snap()) === base, 'body drag on a selected object does nothing');
    await dragFrom(pt.left, pt.bottom, 260, -160);    // marquee from empty space
    check(stable(await snap()) === base, 'marquee / click on empty space does not change the selection');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'right', buttons: 2, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'right', buttons: 0, clickCount: 1 });
    await sleep(150);
    check(stable(await snap()) === base && !(await snap()).ctxMenu, 'right click opens no context menu');

    // ── Esc order: support selection -> active tool -> leave ──
    await run(`(async () => {
      const { supportMode } = await import('/src/supports/SupportMode.ts');
      window.__esc = { sel: true, tool: true };
      window.__escOff = [
        supportMode.addEscapeHook('selection', () => { if (!window.__esc.sel) return false; window.__esc.sel = false; return true; }),
        supportMode.addEscapeHook('tool', () => { if (!window.__esc.tool) return false; window.__esc.tool = false; return true; }),
      ];
    })()`);
    await press('Escape');
    let esc = JSON.parse(await run(`JSON.stringify({ ...window.__esc })`));
    check(!esc.sel && esc.tool && (await modeInfo()).active, 'Esc 1 clears the support selection first');
    await press('Escape');
    esc = JSON.parse(await run(`JSON.stringify({ ...window.__esc })`));
    check(!esc.tool && (await modeInfo()).active, 'Esc 2 ends the active tool');
    await run(`window.__escOff.forEach(off => off())`);

    // ── Mode-scoped undo ──
    const supportEdits = await run(`(async () => {
      const { ApplyPresetCommand, commitSupportEdits } = await import('/src/supports/commands/index.ts');
      const { HistoryManager } = await import('/src/core/HistoryManager.js');
      const tops = [];
      commitSupportEdits([new ApplyPresetCommand(${JSON.stringify(a)}, 'HEAVY')]);
      tops.push(HistoryManager.getUndoLabel());
      commitSupportEdits([new ApplyPresetCommand(${JSON.stringify(a)}, 'LIGHT'), new ApplyPresetCommand(${JSON.stringify(b)}, 'MIDDLE')], 'Preset on both');
      tops.push(HistoryManager.getUndoLabel());
      return JSON.stringify(tops);
    })()`).then(JSON.parse);
    check(supportEdits[1] === 'Preset on both', `a batched support edit is one step (${supportEdits[1]})`);
    const presetOf = (id) => run(`(async () => { const { getState } = await import('/src/core/StateManager.js'); return getState().scene.objects[${JSON.stringify(id)}].supports?.settings?.preset ?? null; })()`);
    check(await presetOf(a) === 'LIGHT' && await presetOf(b) === 'MIDDLE', 'batch applied');
    await press('Z', ['ctrl']);
    check(await presetOf(a) === 'HEAVY' && await presetOf(b) !== 'MIDDLE', 'Ctrl+Z undoes the whole batch (found inside the batch)');
    await press('Z', ['ctrl']);
    check(await presetOf(a) !== 'HEAVY', 'Ctrl+Z undoes the earlier support step');
    await press('Z', ['ctrl']);
    const pre = JSON.parse(await run(`JSON.stringify(window.__pre)`));
    info = await modeInfo();
    check(pre.length === 1 && pre[0] === 'do', 'the pre-mode non-support step is NOT undone inside the mode');
    check(info.toasts.some(t => /Support Mode only undoes/.test(t)), 'a kit toast explains why');
    check((await snap()).undo === 'pre-mode step', 'the older step stays on top of the stack');
    await press('Y', ['ctrl']);
    check(await presetOf(a) === 'HEAVY', 'Ctrl+Y redoes the support step');

    // ── Save and export DURING the mode contain all three objects ──
    const captured = await run(`(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('Projects', { create: true });
      const ref = await dir.getFileHandle('support-mode-smoke.mixo', { create: true });
      const { PersistenceManager } = await import('/src/core/PersistenceManager.js');
      const saved = await PersistenceManager.saveAs({ ref, name: 'support-mode-smoke.mixo' });
      const text = await (await ref.getFile()).text();
      let exported = null;
      window.showSaveFilePicker = async () => ({ createWritable: async () => ({
        write: async (data) => { exported = new Uint8Array(data.arrayBuffer ? await data.arrayBuffer() : data); },
        close: async () => {},
      }), name: 'x.3mf', kind: 'file' });
      const { PrintManager } = await import('/src/core/PrintManager.js');
      await PrintManager.exportThreeMF({ acknowledgeWarnings: true });
      let b64 = null;
      if (exported) { let s = ''; for (let i = 0; i < exported.length; i += 0x8000) s += String.fromCharCode.apply(null, exported.subarray(i, i + 0x8000)); b64 = btoa(s); }
      return JSON.stringify({ saved, text, exported: b64 });
    })()`).then(JSON.parse);
    const { default: JSZip } = await import('jszip');
    assert(captured.saved && captured.text, 'save produced a document during the mode');
    assert(captured.exported, 'export produced bytes during the mode');
    const doc = JSON.parse(captured.text);
    const savedObjects = (doc.sceneObjects ?? []).length;
    check(savedObjects === 3, `the save made during the mode holds all 3 objects (${savedObjects})`);
    const exportZip = await JSZip.loadAsync(Buffer.from(captured.exported, 'base64'));
    const model = await exportZip.file('3D/3dmodel.model').async('text');
    const meshes = (model.match(/<mesh>/g) ?? []).length;
    check(meshes === 3, `the 3MF exported during the mode holds all 3 objects (${meshes} meshes)`);
    check((await modeInfo()).active, 'save and export left the mode open');

    if (SHOT) {
      mkdirSync(SHOT, { recursive: true });
      await run(`(async () => { const { SceneManager } = await import('/src/core/SceneManager.js'); const { Selection } = await import('/src/core/Selection.js'); SceneManager.frameSelected(Selection.getSelectedResolved().map(r => r.mesh)); })()`);
      await sleep(900);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(SHOT, 'support-mode.png'), Buffer.from(shot.data, 'base64'));
      console.log(`wrote ${join(SHOT, 'support-mode.png')}`);
    }

    // ── Exit restores everything ──
    await press('Escape');
    info = await modeInfo();
    check(!info.active, 'Esc with nothing left to cancel leaves the mode');
    const after = await snap();
    check(after.masks[c] !== ISOLATION_LAYER && after.masks[a] === after.masks[c], 'exit restores the mask');
    check(JSON.stringify(after.selection) === JSON.stringify([a, b]) && after.active === a, 'exit restores the selection');
    check(info.dataMode === null && info.inert.every(v => v === false) && info.opacity.every(v => v === 1), 'exit restores the panels (data-mode, inert, opacity)');
    check(info.mode === null, 'exit restores the input context');
    check(info.enterExists && !info.done, 'the entry button is back');
    await press('G');
    check((await snap()).modal === true, 'G works again after exit');
    await press('Escape');
    const supportsKept = await presetOf(a);
    check(supportsKept === 'HEAVY', 'supports stay after exit');
    // Done button path + Shift+S exit path
    await run(`document.querySelector('#support-mode-enter').click()`);
    await sleep(200);
    check((await modeInfo()).active, 'the header button enters the mode');
    await run(`document.querySelector('#support-mode-done').click()`);
    await sleep(200);
    check(!(await modeInfo()).active, 'Done leaves the mode');
    await press('S', ['shift']);
    await press('S', ['shift']);
    check(!(await modeInfo()).active, 'Shift+S toggles in and out');

    check(app.exceptions.length === 0, `no uncaught exceptions ${app.exceptions.join(' | ').slice(0, 300)}`);
  } finally {
    await app.close();
  }
  if (failures.length) throw new Error(`${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
  console.log(`PASS support mode smoke`);
}

main().catch((err) => { console.error(`FAIL ${err?.message ?? err}`); process.exitCode = 1; });
