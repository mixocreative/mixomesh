import '@fontsource/zen-kaku-gothic-new/400.css';
import '@fontsource/zen-kaku-gothic-new/500.css';
import '@fontsource/zen-kaku-gothic-new/700.css';
import '../styles/kit.css';
import './gallery.css';
import { useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Check, ColorField, FieldRow, KeyCaps, Modal, Notice, NumberField, ProgressRow, RangeField, Section, Segmented, Select, Toast, ToastProvider, Toggle, useToasts } from '../index';

type Row = readonly [name: string, type: string, note: string];

function State({ name, cls, children }: { name: string; cls?: string; children: ReactNode }) {
  return <div className="g-state"><small>{name}</small><div className={cls}>{children}</div></div>;
}

function Comp({ title, props, states, log }: { title: string; props: readonly Row[]; states: ReactNode; log?: string }) {
  return (
    <section className="g-comp">
      <h2>{title}</h2>
      <div className="g-states">{states}</div>
      {log !== undefined && <div className="g-log">{log}</div>}
      <table className="g-props"><tbody>
        {props.map(([n, t, note]) => <tr key={n}><td><code>{n}</code></td><td><code>{t}</code></td><td>{note}</td></tr>)}
      </tbody></table>
    </section>
  );
}

const noop = () => {};
const SEG = [{ value: 'move', label: 'Move' }, { value: 'rotate', label: 'Rotate' }, { value: 'scale', label: 'Scale' }] as const;
const SEL = [{ value: 'xy', label: 'XY plane' }, { value: 'xz', label: 'XZ plane' }, { value: 'yz', label: 'YZ plane' }] as const;

function ToastDemo() {
  const { push } = useToasts();
  return <Button onClick={() => push({ message: 'Object deleted', action: { label: 'Undo', onClick: noop }, timeoutMs: 8000 })}>Push live toast (8 s)</Button>;
}

function Gallery() {
  const [secA, setSecA] = useState<boolean | undefined>(undefined);
  const [secLog, setSecLog] = useState('');
  const [modal, setModal] = useState(false);
  const [modalOpenStatic, setModalOpenStatic] = useState(true);
  const [seg, setSeg] = useState<'move' | 'rotate' | 'scale'>('move');
  const [tog, setTog] = useState(true);
  const [chk, setChk] = useState(true);
  const [sel, setSel] = useState<'xy' | 'xz' | 'yz'>('xy');
  const [w, setW] = useState(42);
  const [live, setLive] = useState(42);
  const [commits, setCommits] = useState(0);
  const [ang, setAng] = useState(90);
  const [mul, setMul] = useState(1.5);
  const [rng, setRng] = useState(2.5);
  const [col, setCol] = useState('#7f0019');
  return (
    <div className="mx-kit gallery"><ToastProvider>
      <h1>MIXOMESH UI kit</h1>
      <p className="g-note">Dev-only gallery (kit.html). mixo-app-style, scoped under .mx-kit. Hover and focus columns are forced classes mirroring the real :hover / :focus-visible rules.</p>

      <Comp title="Button" props={[
        ['variant', "'primary' | 'danger' | 'plain' | 'icon'", 'primary = the one red action; danger = outline; icon needs aria-label'],
        ['...button attrs', 'ButtonHTMLAttributes', 'disabled, onClick, ref (forwardRef)'],
      ]} states={<>
        <State name="default"><Button variant="primary">Export</Button><Button variant="danger">Delete</Button><Button>Cancel</Button><Button variant="icon" aria-label="Add">+</Button></State>
        <State name="hover" cls="g-hover"><Button variant="primary">Export</Button><Button variant="danger">Delete</Button><Button>Cancel</Button><Button variant="icon" aria-label="Add">+</Button></State>
        <State name="focus" cls="g-focus"><Button>Cancel</Button><Button variant="icon" aria-label="Add">+</Button></State>
        <State name="disabled"><Button variant="primary" disabled>Export</Button><Button variant="danger" disabled>Delete</Button><Button disabled>Cancel</Button><Button variant="icon" aria-label="Add" disabled>+</Button></State>
      </>} />

      <Comp title="Segmented" props={[
        ['label', 'string', 'accessible name of the group'], ['options', 'SegmentedOption<V>[]', '{ value, label, title?, disabled? }'],
        ['value / onChange', 'V / (v: V) => void', 'arrow keys move the choice, one tab stop'], ['disabled', 'boolean', ''],
      ]} states={<>
        <State name="default / active"><Segmented label="Tool" options={SEG} value={seg} onChange={setSeg} /></State>
        <State name="hover" cls="g-hover"><Segmented label="Tool hover" options={SEG} value="move" onChange={noop} /></State>
        <State name="focus" cls="g-focus"><Segmented label="Tool focus" options={SEG} value="rotate" onChange={noop} /></State>
        <State name="disabled"><Segmented label="Tool off" options={SEG} value="move" onChange={noop} disabled /></State>
      </>} />

      <Comp title="Toggle" props={[
        ['pressed / onChange', 'boolean / (p: boolean) => void', 'feature, mode, visibility (aria-pressed, ink fill)'], ['...button attrs', '', 'disabled, ref'],
      ]} states={<>
        <State name="default (off)"><Toggle pressed={false} onChange={noop}>Grid</Toggle></State>
        <State name="active (on)"><Toggle pressed={tog} onChange={setTog}>Grid</Toggle></State>
        <State name="hover" cls="g-hover"><Toggle pressed={false} onChange={noop}>Grid</Toggle></State>
        <State name="focus" cls="g-focus"><Toggle pressed={false} onChange={noop}>Axes</Toggle></State>
        <State name="disabled"><Toggle pressed={false} disabled onChange={noop}>Grid</Toggle><Toggle pressed disabled onChange={noop}>Axes</Toggle></State>
      </>} />

      <Comp title="Check" props={[
        ['label', 'ReactNode', ''], ['checked / onChange', 'boolean / (c: boolean) => void', 'sub-option; a feature is a Toggle'], ['...input attrs', '', 'disabled, ref'],
      ]} states={<>
        <State name="default / active"><Check label="Snap to bed" checked={chk} onChange={setChk} /><Check label="Show edges" checked={false} onChange={noop} /></State>
        <State name="focus" cls="g-focus"><Check label="Snap to bed" checked={false} onChange={noop} /></State>
        <State name="disabled"><Check label="Snap to bed" checked disabled onChange={noop} /><Check label="Show edges" checked={false} disabled onChange={noop} /></State>
      </>} />

      <Comp title="Select" props={[
        ['label', 'string', 'visible label, bound to the select'], ['options', 'SelectOption<V>[]', '{ value, label, disabled? }'], ['value / onChange', 'V / (v: V) => void', ''],
      ]} states={<>
        <State name="default"><Select label="Plane" options={SEL} value={sel} onChange={setSel} /></State>
        <State name="hover" cls="g-hover"><Select label="Plane" options={SEL} value="xz" onChange={noop} /></State>
        <State name="focus" cls="g-focus"><Select label="Plane" options={SEL} value="yz" onChange={noop} /></State>
        <State name="disabled"><Select label="Plane" options={SEL} value="xy" onChange={noop} disabled /></State>
      </>} />

      <Comp title="NumberField" log={`live (onInput): ${live} mm   committed (onCommit): ${w} mm   commits: ${commits}`} props={[
        ['label', 'string', 'drag it sideways to scrub (4 px per step; Shift x10, Alt /10)'], ['value', 'number', ''],
        ['unit', "'mm' | 'deg' | '×' | string", 'shown after the value, accepted when typed ("2mm", "1,5x", "45°")'],
        ['min / max / step', 'number', 'typed and scrubbed values clamp; arrows step'],
        ['onInput', '(v: number) => void', 'live, while scrubbing; no undo entry'], ['onCommit', '(v: number) => void', 'scrub release, Enter, blur, arrow step'], ['disabled', 'boolean', ''],
      ]} states={<>
        <State name="default (mm, 0-300)"><NumberField label="Width" unit="mm" min={0} max={300} step={0.5} value={w} onInput={setLive} onCommit={(v) => { setW(v); setLive(v); setCommits((c) => c + 1); }} /></State>
        <State name="deg"><NumberField label="Angle" unit="deg" min={0} max={360} step={1} value={ang} onCommit={setAng} /></State>
        <State name="multiplier"><NumberField label="Scale" unit="×" min={0.01} step={0.05} value={mul} onCommit={setMul} /></State>
        <State name="hover" cls="g-hover"><NumberField label="Width" unit="mm" value={12} onCommit={noop} /></State>
        <State name="focus" cls="g-focus"><NumberField label="Width" unit="mm" value={12} onCommit={noop} /></State>
        <State name="disabled"><NumberField label="Width" unit="mm" value={12} disabled onCommit={noop} /></State>
      </>} />

      <Comp title="RangeField" props={[
        ['label / value / min / max / step', 'string / number ...', ''], ['unit', 'string', 'shown after the number'],
        ['onInput', '(v: number) => void', 'live, while the slider moves'], ['onCommit', '(v: number) => void', 'slider release / key up, number Enter / blur'], ['disabled', 'boolean', ''],
      ]} states={<>
        <State name="default"><RangeField label="Thickness" unit="mm" min={0} max={10} step={0.5} value={rng} onCommit={setRng} /></State>
        <State name="hover" cls="g-hover"><RangeField label="Thickness" unit="mm" min={0} max={10} step={0.5} value={4} onCommit={noop} /></State>
        <State name="focus" cls="g-focus"><RangeField label="Thickness" unit="mm" min={0} max={10} step={0.5} value={4} onCommit={noop} /></State>
        <State name="disabled"><RangeField label="Thickness" unit="mm" min={0} max={10} step={0.5} value={4} disabled onCommit={noop} /></State>
      </>} />

      <Comp title="ColorField" props={[
        ['label', 'string', ''], ['value', '"#rrggbb"', 'hex readout beside the swatch'],
        ['onInput', '(hex: string) => void', 'live, while the picker is dragged'], ['onCommit', '(hex: string) => void', 'native change event (picker closes)'], ['...input attrs', '', 'disabled, ref'],
      ]} states={<>
        <State name="default"><ColorField label="Tint" value={col} onCommit={setCol} /></State>
        <State name="focus" cls="g-focus"><ColorField label="Tint" value="#1d3461" onCommit={noop} /></State>
        <State name="disabled"><ColorField label="Tint" value="#1d3461" disabled onCommit={noop} /></State>
      </>} />

      <Comp title="Section" log={`controlled collapsed: ${String(secA)}   ${secLog}`} props={[
        ['title', 'ReactNode', ''],
        ['collapsed', 'boolean | undefined', 'tri-state: true = hide, false = show, undefined = defer to defaultCollapsed'],
        ['defaultCollapsed', 'boolean', 'workspace default used while collapsed is undefined'], ['onCollapsedChange', '(c: boolean) => void', 'header click / Enter / Space'],
        ['onReset', '() => void', 'shows the reset button; never toggles collapse'], ['onCopyFromActive', '() => void', 'shows the copy-from-active button; never toggles collapse'],
      ]} states={<>
        <State name="expanded + both header buttons"><Section title="TRANSFORM" collapsed={false} onReset={() => setSecLog('reset')} onCopyFromActive={() => setSecLog('copy')}><FieldRow label="X">0 mm</FieldRow></Section></State>
        <State name="collapsed"><Section title="SHADER" collapsed onReset={noop}><p>hidden</p></Section></State>
        <State name="undefined, defaultCollapsed"><Section title="UV OVERRIDE" defaultCollapsed><p>hidden</p></Section></State>
        <State name="undefined, default expanded"><Section title="EXPORT"><FieldRow label="Ratio">1:1</FieldRow></Section></State>
        <State name="live (click header)"><Section title="LIVE" collapsed={secA} defaultCollapsed onCollapsedChange={setSecA} onReset={() => setSecLog('reset')}><FieldRow label="Row">value</FieldRow></Section></State>
      </>} />

      <Comp title="FieldRow" props={[
        ['label', 'ReactNode', ''], ['children', 'ReactNode | (id) => ReactNode', 'control; render prop receives the id the label binds to'], ['hint', 'ReactNode', 'muted line under the row'],
      ]} states={<>
        <State name="default"><FieldRow label="Name">{(id) => <input id={id} defaultValue="Crown" />}</FieldRow></State>
        <State name="with hint"><FieldRow label="Ratio" hint="Applies to export only">{(id) => <input id={id} defaultValue="1.0" />}</FieldRow></State>
        <State name="focus" cls="g-focus"><FieldRow label="Name">{(id) => <input id={id} defaultValue="Crown" />}</FieldRow></State>
      </>} />

      <Comp title="Modal" props={[
        ['open / onClose', 'boolean / () => void', 'Esc, scrim click and Close call onClose'], ['title', 'string', 'aria-labelledby target'],
        ['actions', 'ModalAction[]', '{ label, onClick, variant: primary | danger | plain, disabled } - extra primaries demote to plain'],
        ['behaviour', '', 'focus trapped, first control focused, focus returns to the opener'],
      ]} states={<>
        <State name="live"><Button onClick={() => setModal(true)}>Open modal</Button></State>
        <State name="static preview (below)"><Button onClick={() => setModalOpenStatic((o) => !o)}>{modalOpenStatic ? 'Hide' : 'Show'} preview</Button></State>
      </>} />
      <Modal open={modal} title="Delete object?" onClose={() => setModal(false)} actions={[{ label: 'Cancel', onClick: () => setModal(false) }, { label: 'Delete', variant: 'danger', onClick: () => setModal(false) }]}>This removes the object and its shader slots.</Modal>
      {modalOpenStatic && <div className="g-modal-preview"><Modal open title="Repair mesh?" onClose={() => setModalOpenStatic(false)} actions={[{ label: 'Cancel', onClick: () => setModalOpenStatic(false) }, { label: 'Repair', variant: 'primary', onClick: () => setModalOpenStatic(false) }]}>3 holes found. Repair closes them and keeps UVs.</Modal></div>}

      <Comp title="Toast" props={[
        ['ToastProvider', 'context', 'useToasts() => { push(spec), dismiss(id) }; no global singleton'],
        ['message / action / timeoutMs', 'string / {label,onClick} / number', 'default 5000 ms, 0 = sticky; action runs then dismisses'],
      ]} states={<>
        <State name="with Undo"><div className="g-inline-toast"><Toast message="Object deleted" action={{ label: 'Undo', onClick: noop }} timeoutMs={0} onDismiss={noop} /></div></State>
        <State name="message only"><div className="g-inline-toast"><Toast message="Saved" timeoutMs={0} onDismiss={noop} /></div></State>
        <State name="live (bottom right)"><ToastDemo /></State>
      </>} />

      <Comp title="ProgressRow" props={[
        ['label', 'string', ''], ['value', 'number (0..1) | undefined', 'undefined = indeterminate'], ['onCancel', '() => void', 'shows Cancel'],
      ]} states={<>
        <State name="determinate"><ProgressRow label="Repairing" value={0.45} /></State>
        <State name="determinate + cancel"><ProgressRow label="Exporting" value={0.8} onCancel={noop} /></State>
        <State name="indeterminate"><ProgressRow label="Loading" onCancel={noop} /></State>
      </>} />

      <Comp title="KeyCaps" props={[['shortcut', 'string', '"Ctrl+Shift+Z" split on +']]} states={<>
        <State name="default"><span><KeyCaps shortcut="Ctrl+Shift+Z" /></span><span><KeyCaps shortcut="Delete" /></span></State>
      </>} />

      <Comp title="Notice" props={[
        ['severity', "'info' | 'warn' | 'error'", ''], ['children', 'ReactNode', 'text'], ['actions', '{label,onClick}[]', 'own row below the text'],
      ]} states={<>
        <State name="info"><Notice severity="info">Autosave restored 2 objects.</Notice></State>
        <State name="warn"><Notice severity="warn" actions={[{ label: 'Repair', onClick: noop }, { label: 'Ignore', onClick: noop }]}>Mesh is not watertight: 3 open holes.</Notice></State>
        <State name="error"><Notice severity="error" actions={[{ label: 'Details', onClick: noop }]}>Export failed: texture could not be read.</Notice></State>
      </>} />
    </ToastProvider></div>
  );
}

createRoot(document.getElementById('kit-root') as HTMLElement).render(<Gallery />);
