import '@fontsource/zen-kaku-gothic-new/400.css';
import '@fontsource/zen-kaku-gothic-new/500.css';
import '@fontsource/zen-kaku-gothic-new/700.css';
import '../styles/kit.css';
import './gallery.css';
import { useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Check, ColorField, NumberField, RangeField, Segmented, Select, Toggle } from '../index';

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

function Gallery() {
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
    <div className="mx-kit gallery">
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
    </div>
  );
}

createRoot(document.getElementById('kit-root') as HTMLElement).render(<Gallery />);
