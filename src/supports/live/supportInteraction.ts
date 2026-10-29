/**
 * Pointer gestures of Support Mode (plan P3.5): Add / remove / select / Drag over on the active
 * object, and the zone brush. Decisions come from `@mixo-geocore/editing` (pickAction, planAddTip via
 * AddSupportCommand, contactToRemove, createStroke / zoneFill, brushHits); this file only turns DOM
 * pointer events into those inputs through BabylonViewportPort and lands the outcome as ONE support
 * command per gesture (a Drag over stroke is a selection, which is view state, not history).
 *
 * Per-frame values (ghost tip, remove ring, brush ring) go to the layers directly, never through
 * React or state (D14): pointer moves only store the latest point; one rAF per frame probes the
 * model and the supports with the engine session and places the layers.
 */
import { pickAction } from '@mixo-geocore/editing/pick';
import { contactToRemove } from '@mixo-geocore/editing/removal';
import { createStroke, zoneFill } from '@mixo-geocore/editing/stroke';
import { bodySegments, brushHits, type BodySegments, type BrushSession } from '@mixo-geocore/editing/screenBrush';
import { effectiveBrushMode } from '@mixo-geocore/editing/selection';
import { selectsTips } from '@mixo-geocore/editing/session';
import { meshTier } from '@mixo-geocore/host/core/budget';
import { sharedSession } from '@mixo-geocore/host/workers/geometryClient';
import { supportEngine } from '@mixo-geocore/host/supports/supportEngine';
import type { ZoneStamp } from '@mixo-geocore/host/core/supports/zones';
import type { SurfacePick } from '@mixo-geocore/editing/ViewportPort';
import { t } from '../../i18n/index.js';
import { supportMode } from '../SupportMode';
import { supportSession } from '../../panels/supports/sessionStore';
import { AddSupportCommand, DeleteSupportsCommand, StampStrokeCommand, commitSupportEdits } from '../commands';
import { anchorOffset, babylonToSupport } from '../BabylonViewportPort';
import { normalToEngine, type Vec3 } from '../frame';
import { leadPosition, objectModel, type ObjectModel } from '../objectModel';
import { readStamps } from '../model';
import { readSupports } from '../store';
import { cachedPlacement } from '../supportCache';
import { appSupportLayers, type SupportLayers } from '../layers/index';
import { notify } from './notices';
import { contactOfTriangle, liveContacts } from './jobInputs';
import { fixSpotAdded } from './fixSpot';

/* eslint-disable @typescript-eslint/no-explicit-any -- Babylon / engine session are untyped here */

interface Hit { kind: 'model' | 'support'; pick: SurfacePick; contactId?: string }

const IDENTITY = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

class Interaction {
  private layers: SupportLayers | undefined;
  private canvas: HTMLCanvasElement | undefined;
  private pointer: [number, number] | undefined;
  private frame: number | undefined;
  private down: { x: number; y: number; button: number; ctrl: boolean; shift: boolean } | undefined;
  private lastBrush: [number, number] | undefined;
  private bodies: { built: unknown; segments: BodySegments } | undefined;
  private pendingStamps: ZoneStamp[] = [];
  private zoneObject: string | undefined;
  private readonly stroke = createStroke(() => this.endStroke());
  private strokeKind: 'zones' | 'drag' | undefined;
  private offs: Array<() => void> = [];

  async start(): Promise<void> {
    this.layers = await appSupportLayers();
    const canvas = (window as any).BABYLON ? this.layers.scene.getEngine().getRenderingCanvas() : undefined;
    if (!canvas || !supportMode.isActive()) return;
    this.canvas = canvas;
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      canvas.addEventListener(type, fn as EventListener);
      this.offs.push(() => canvas.removeEventListener(type, fn as EventListener));
    };
    on('pointerdown', (e) => this.onDown(e));
    on('pointermove', (e) => this.onMove(e));
    on('pointerup', (e) => this.onUp(e));
    on('pointerleave', () => { this.pointer = undefined; this.clearPointerLayers(); });
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Shift' && supportSession.get().shiftHeld !== (e.type === 'keydown')) supportSession.send({ type: 'shift', held: e.type === 'keydown' });
    };
    window.addEventListener('keydown', keys);
    window.addEventListener('keyup', keys);
    this.offs.push(() => { window.removeEventListener('keydown', keys); window.removeEventListener('keyup', keys); });
    this.offs.push(supportSession.subscribe(() => this.onSession()));
    this.layers.setEditingObject(this.target());
  }

  stop(): void {
    this.offs.forEach((off) => off());
    this.offs = [];
    this.stroke.end();
    this.clearPointerLayers();
    if (this.canvas) this.canvas.style.cursor = '';
    this.layers?.setEditingObject(undefined);
    this.canvas = undefined;
  }

  private target(): string | undefined {
    return supportSession.get().activeUnitId;
  }

  private onSession(): void {
    const s = supportSession.get();
    const id = this.target();
    if (id && this.layers) {
      this.layers.setEditingObject(id);
      this.layers.setSelection(id, s.selection);
    }
    if (id) {
      const om = objectModel(id);
      const tris = om ? om.model.local.indices.length / 3 : 0;
      const heavy = om && meshTier(tris, 'web') === 'heavy' ? tris : undefined;
      if (s.heavy !== heavy) supportSession.send({ type: 'activeUnitChanged', id, heavy });
    }
    if (this.canvas) this.canvas.style.cursor = s.mode === 'edit' && s.tool === 'add' && s.addAction === 'add' ? 'crosshair' : s.mode === 'zones' ? 'crosshair' : '';
    this.schedule();
  }

  // ── events ──

  private local(e: PointerEvent): [number, number] {
    const r = this.canvas!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private onMove(e: PointerEvent): void {
    this.pointer = this.local(e);
    const s = supportSession.get();
    if (this.stroke.active && (e.buttons & 1)) this.sample(this.pointer, s);
    this.schedule();
  }

  private onDown(e: PointerEvent): void {
    const s = supportSession.get();
    const id = this.target();
    if (!id || s.mode === 'off' || s.heavy !== undefined) return;
    const at = this.local(e);
    this.down = { x: at[0], y: at[1], button: e.button, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
    if (e.button !== 0) return;
    if (s.mode === 'zones' || (s.mode === 'edit' && s.tool === 'select' && s.selectStyle === 'brush')) {
      const hit = this.hitAt(at, id);
      if (!hit) return;
      this.strokeKind = s.mode === 'zones' ? 'zones' : 'drag';
      this.stroke.begin(0);
      this.lastBrush = undefined;
      this.pendingStamps = [];
      this.zoneObject = id;
      this.sample(at, s);
    }
  }

  private onUp(e: PointerEvent): void {
    const down = this.down;
    this.down = undefined;
    if (this.stroke.active && e.button === 0) { this.stroke.end(); return; }
    const id = this.target();
    const s = supportSession.get();
    if (!down || !id || s.mode !== 'edit' || s.heavy !== undefined) return;
    const at = this.local(e);
    const travel = Math.hypot(at[0] - down.x, at[1] - down.y);
    const hit = this.hitAt(at, id);
    const action = pickAction({
      hit: hit?.kind === 'support' ? 'support' : 'model',
      button: down.button === 2 ? 'right' : 'left',
      ctrl: down.ctrl,
      shift: down.shift,
      travel,
      mode: 'edit',
      tool: s.tool,
      selectStyle: s.selectStyle,
      addAction: s.addAction,
      active: true,
      contact: hit?.contactId !== undefined,
    });
    if (down.button !== 0 && down.button !== 2) return;
    if (!hit && action.type !== 'miss') return;
    this.apply(action.type, id, hit, s.addAction === 'remove' || down.ctrl || down.button === 2);
  }

  // ── actions ──

  private apply(type: string, id: string, hit: Hit | undefined, removing: boolean): void {
    const om = objectModel(id);
    const record = readSupports(id);
    if (!om || !record) return;
    const local = hit ? this.toSupport(om, id, hit.pick) : undefined;
    switch (type) {
      case 'add': {
        if (!local) return;
        const command = new AddSupportCommand(id, { point: local.point, normal: local.normal, worldNormal: local.normal, candidates: cachedPlacement(id) ?? [], minFromUpDeg: 10 });
        commitSupportEdits([command]);
        if (command.plan?.status === 'faces-up') notify({ message: t('supportLive.facesUp') });
        fixSpotAdded(id, command.plan?.contact.position as Vec3 | undefined);
        break;
      }
      case 'erase': {
        if (!local) return;
        const doomed = contactToRemove(liveContacts(id, record), local.point, record.settings.eraseRadius);
        if (doomed) commitSupportEdits([new DeleteSupportsCommand(id, [doomed.id])]);
        else void removing;
        break;
      }
      case 'removeContact': {
        if (hit?.contactId) commitSupportEdits([new DeleteSupportsCommand(id, [hit.contactId])]);
        break;
      }
      case 'toggle': {
        if (hit?.contactId) supportSession.send({ type: 'toggleContact', id: hit.contactId });
        break;
      }
      case 'miss':
        notify({ message: t(supportSession.get().tool === 'select' ? 'supportLive.missSupport' : 'supportLive.missModel') });
        break;
      default:
    }
  }

  /** Stroke sample: a zone stamp, or Drag over's brush on the supports. */
  private sample(at: [number, number], s = supportSession.get()): void {
    const id = this.zoneObject ?? this.target();
    if (!id || !this.layers) return;
    const om = objectModel(id);
    if (!om) return;
    if (this.strokeKind === 'zones') {
      const hit = this.hitAt(at, id, 'model');
      if (!hit) return;
      const local = this.toSupport(om, id, hit.pick);
      const centres = this.stroke.samples(local.point, zoneFill(s.zoneRadius));
      for (const centre of centres) this.pendingStamps.push({ kind: s.zoneKind, center: [...centre], radius: s.zoneRadius, normal: [...local.normal] });
      if (centres.length > 0) {
        const record = readSupports(id);
        this.layers.setZones(id, om.model.local as any, om.anchor, om.version, [...readStamps(record?.stamps ?? { kinds: '', data: [] }), ...this.pendingStamps]);
      }
    } else if (this.strokeKind === 'drag') {
      const ids = this.brushIds(id, om, this.lastBrush, at, s);
      this.lastBrush = at;
      if (ids.length > 0) supportSession.send({ type: 'paint', ids, mode: effectiveBrushMode(s.brushMode, s.shiftHeld) });
    }
  }

  private brushIds(id: string, om: ObjectModel, from: [number, number] | undefined, to: [number, number], s = supportSession.get()): string[] {
    const layer = this.layers!.supportLayer(id);
    const built = layer?.built;
    const session = sharedSession() as unknown as BrushSession | undefined;
    if (!built || !session) return [];
    if (this.bodies?.built !== built) this.bodies = { built, segments: bodySegments(supportEngine() as any, built) };
    const handle = this.layers!.picks.handle(`model:${id}`, om.version, () => ({ objectId: id, anchor: om.anchor, mesh: om.model.local, side: 2 }));
    const occluders = handle === undefined ? [] : [{ handle, toLocal: IDENTITY, side: 2 }];
    const mode = effectiveBrushMode(s.brushMode, s.shiftHeld);
    const selected = s.selection;
    return brushHits(session, this.bodies.segments, occluders, this.layers!.port.brushView(), from, to, s.brushRadius, 0,
      (cid) => (mode === 'select' ? !selected.has(cid) : selected.has(cid)));
  }

  private endStroke(): void {
    const id = this.zoneObject;
    const stamps = this.pendingStamps;
    this.pendingStamps = [];
    this.zoneObject = undefined;
    const kind = this.strokeKind;
    this.strokeKind = undefined;
    this.lastBrush = undefined;
    if (kind === 'zones' && id && stamps.length > 0) commitSupportEdits([new StampStrokeCommand(id, stamps)]);
  }

  // ── picking ──

  private toSupport(om: ObjectModel, id: string, pick: SurfacePick): { point: Vec3; normal: Vec3 } {
    const offset = anchorOffset(om.anchor, leadPosition(id));
    return { point: babylonToSupport(pick.point as Vec3, om.anchor, offset), normal: normalToEngine(pick.normal as Vec3) };
  }

  /** The nearest hit under a screen point on the object's model or its supports. */
  private hitAt(at: readonly [number, number], id: string, only?: 'model' | 'support'): Hit | undefined {
    const layers = this.layers;
    const om = objectModel(id);
    if (!layers || !om) return undefined;
    const ray = layers.port.screenToRay(at);
    if (!ray) return undefined;
    let best: Hit | undefined;
    if (only !== 'support') {
      const handle = layers.picks.handle(`model:${id}`, om.version, () => ({ objectId: id, anchor: om.anchor, mesh: om.model.local, side: 2 }));
      const pick = handle === undefined ? undefined : layers.port.pick(handle, ray);
      if (pick) best = { kind: 'model', pick };
    }
    if (only !== 'model') {
      const handle = layers.supportPickHandle(id);
      const pick = handle === undefined ? undefined : layers.port.pick(handle, ray);
      const built = layers.supportLayer(id)?.built;
      if (pick && built && (!best || pick.distance < best.pick.distance)) {
        const contactId = contactOfTriangle(built.components, pick.triangle);
        best = contactId ? { kind: 'support', pick, contactId } : { kind: 'support', pick };
      }
    }
    return best;
  }

  // ── per-frame layers (D14) ──

  private schedule(): void {
    if (this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => { this.frame = undefined; this.place(); });
  }

  private clearPointerLayers(): void {
    this.layers?.setGhostTip(undefined);
    const id = this.target();
    if (id) this.layers?.setRemoveRing(id, undefined);
    this.layers?.setBrush(undefined);
    this.layers?.setPointer(undefined);
  }

  private place(): void {
    const layers = this.layers;
    const id = this.target();
    const s = supportSession.get();
    if (!layers || !id || !this.pointer || s.mode === 'off' || s.heavy !== undefined || this.stroke.active && this.strokeKind === 'drag') {
      if (layers && this.stroke.active) layers.setPointer(this.pointer);
      else this.clearPointerLayers();
      if (layers && s.mode === 'edit' && s.tool === 'select' && s.selectStyle === 'brush') layers.setBrush(s.brushRadius);
      return;
    }
    const record = readSupports(id);
    layers.setBrush(s.mode === 'edit' && selectsTips(s) && s.selectStyle === 'brush' ? s.brushRadius : undefined);
    const hit = this.hitAt(this.pointer, id);
    const adding = s.mode === 'edit' && s.tool === 'add' && s.addAction === 'add';
    const removing = s.mode === 'edit' && s.tool === 'add' && s.addAction === 'remove';
    if (s.mode === 'zones') {
      layers.setGhostTip(undefined);
      layers.setRemoveRing(id, hit?.kind === 'model' ? { point: hit.pick.point as Vec3, normal: hit.pick.normal as Vec3, radiusMm: s.zoneRadius } : undefined);
    } else if (adding && hit?.kind === 'model' && record) {
      layers.setRemoveRing(id, undefined);
      layers.setGhostTip({ point: hit.pick.point as Vec3, normal: hit.pick.normal as Vec3, lengthMm: Math.max(2, record.settings.neckLength + 1), diameterMm: Math.max(0.6, record.settings.pointDiameter * 2) });
    } else if ((removing || (s.mode === 'edit' && s.tool === 'add')) && hit && record) {
      layers.setGhostTip(undefined);
      layers.setRemoveRing(id, { point: hit.pick.point as Vec3, normal: hit.pick.normal as Vec3, radiusMm: record.settings.eraseRadius }, liveContacts(id, record));
    } else {
      layers.setGhostTip(undefined);
      layers.setRemoveRing(id, undefined);
    }
  }
}

let interaction: Interaction | undefined;

/** Start / stop the gestures with the mode. */
export function installSupportInteraction(): void {
  supportMode.onChange((info) => {
    if (info.active && !interaction) {
      interaction = new Interaction();
      void interaction.start();
    } else if (!info.active && interaction) {
      interaction.stop();
      interaction = undefined;
    }
  });
}
