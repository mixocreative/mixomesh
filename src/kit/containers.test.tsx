import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { Section } from './Section';
import { FieldRow } from './FieldRow';
import { Modal } from './Modal';
import { Toast, ToastProvider, useToasts } from './Toast';
import { ProgressRow } from './ProgressRow';
import { KeyCaps } from './KeyCaps';
import { Notice } from './Notice';

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Section', () => {
  it('tri-state: undefined defers to defaultCollapsed, explicit wins', () => {
    const { rerender } = render(<Section title="Transform" defaultCollapsed><p>body</p></Section>);
    expect(screen.getByRole('button', { name: 'Transform' }).getAttribute('aria-expanded')).toBe('false');
    rerender(<Section title="Transform" collapsed={false} defaultCollapsed><p>body</p></Section>);
    expect(screen.getByRole('button', { name: 'Transform' }).getAttribute('aria-expanded')).toBe('true');
    rerender(<Section title="Transform" collapsed={true}><p>body</p></Section>);
    expect(screen.getByRole('button', { name: 'Transform' }).getAttribute('aria-expanded')).toBe('false');
    rerender(<Section title="Transform"><p>body</p></Section>);
    expect(screen.getByRole('button', { name: 'Transform' }).getAttribute('aria-expanded')).toBe('true');
  });
  it('reports the toggled value (from the effective state) once per click', () => {
    const fn = vi.fn();
    render(<Section title="T" defaultCollapsed onCollapsedChange={fn}>x</Section>);
    fireEvent.click(screen.getByRole('button', { name: 'T' }));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(false);
  });
  it('keyboard Enter/Space on the header button toggles (native button click)', () => {
    const fn = vi.fn();
    render(<Section title="T" collapsed={false} onCollapsedChange={fn}>x</Section>);
    const b = screen.getByRole('button', { name: 'T' });
    b.focus();
    fireEvent.click(b);
    expect(fn).toHaveBeenCalledWith(true);
  });
  it('reset and copy buttons fire but do not toggle collapse', () => {
    const toggle = vi.fn(); const reset = vi.fn(); const copy = vi.fn();
    render(<Section title="T" onCollapsedChange={toggle} onReset={reset} onCopyFromActive={copy}>x</Section>);
    fireEvent.click(screen.getByRole('button', { name: 'Reset section' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy from active' }));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(toggle).not.toHaveBeenCalled();
  });
  it('omits header buttons when handlers are absent; hides body when collapsed', () => {
    render(<Section title="T" collapsed><p>inner</p></Section>);
    expect(screen.queryByRole('button', { name: 'Reset section' })).toBeNull();
    expect(screen.getByText('inner').closest('.mx-section-body')?.hasAttribute('hidden')).toBe(true);
  });
});

describe('FieldRow', () => {
  it('binds label to the control via render prop and shows hint', () => {
    render(<FieldRow label="Name" hint="Shown in the outliner">{(id) => <input id={id} />}</FieldRow>);
    expect(screen.getByLabelText('Name')).toBeTruthy();
    expect(screen.getByText('Shown in the outliner')).toBeTruthy();
  });
  it('renders plain children without a hint', () => {
    render(<FieldRow label="L"><button>go</button></FieldRow>);
    expect(screen.getByText('go')).toBeTruthy();
    expect(document.querySelector('.mx-hint')).toBeNull();
  });
});

describe('Modal', () => {
  it('renders nothing when closed; labelled dialog when open', () => {
    const { rerender } = render(<Modal open={false} title="Confirm" onClose={() => {}}>b</Modal>);
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(<Modal open title="Confirm" onClose={() => {}}>b</Modal>);
    expect(screen.getByRole('dialog', { name: 'Confirm' })).toBeTruthy();
  });
  it('Esc closes', () => {
    const fn = vi.fn();
    render(<Modal open title="T" onClose={fn}><button>in</button></Modal>);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('focuses first control, traps Tab both ways', () => {
    render(<Modal open title="T" onClose={() => {}} actions={[{ label: 'OK', onClick: () => {}, variant: 'primary' }]}><button>first</button></Modal>);
    const first = screen.getByText('first'); const ok = screen.getByText('OK');
    expect(document.activeElement).toBe(first);
    ok.focus();
    fireEvent.keyDown(ok, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(ok);
  });
  it('returns focus to the opener on close', () => {
    function Host() {
      const [o, setO] = useState(false);
      return <><button onClick={() => setO(true)}>open</button><Modal open={o} title="T" onClose={() => setO(false)}><button>in</button></Modal></>;
    }
    render(<Host />);
    const opener = screen.getByText('open');
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByText('in'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
  it('allows only one primary action; danger is an outline class, never filled', () => {
    render(<Modal open title="T" onClose={() => {}} actions={[
      { label: 'A', onClick: () => {}, variant: 'primary' }, { label: 'B', onClick: () => {}, variant: 'primary' }, { label: 'Del', onClick: () => {}, variant: 'danger' },
    ]}>x</Modal>);
    expect(document.querySelectorAll('.mx-modal-actions .primary').length).toBe(1);
    expect(screen.getByText('Del').className).toBe('danger');
  });
});

describe('Toast', () => {
  it('auto-dismisses after the timeout', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    render(<Toast message="Saved" timeoutMs={1000} onDismiss={fn} />);
    act(() => { vi.advanceTimersByTime(999); });
    expect(fn).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(2); });
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('timeoutMs 0 is sticky', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    render(<Toast message="Saved" timeoutMs={0} onDismiss={fn} />);
    act(() => { vi.advanceTimersByTime(60000); });
    expect(fn).not.toHaveBeenCalled();
  });
  it('action runs then dismisses; the x dismisses', () => {
    const act1 = vi.fn(); const d = vi.fn();
    render(<Toast message="Deleted" action={{ label: 'Undo', onClick: act1 }} onDismiss={d} />);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(act1).toHaveBeenCalledTimes(1);
    expect(d).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(d).toHaveBeenCalledTimes(2);
  });
  it('provider stacks toasts, removes on dismiss and on timeout', () => {
    vi.useFakeTimers();
    function Pusher() {
      const { push } = useToasts();
      return <><button onClick={() => push({ message: 'one', timeoutMs: 1000 })}>p1</button><button onClick={() => push({ message: 'two', timeoutMs: 0 })}>p2</button></>;
    }
    render(<ToastProvider><Pusher /></ToastProvider>);
    fireEvent.click(screen.getByText('p1')); fireEvent.click(screen.getByText('p2'));
    expect(screen.getByText('one')).toBeTruthy(); expect(screen.getByText('two')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1100); });
    expect(screen.queryByText('one')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('two')).toBeNull();
  });
  it('useToasts outside a provider throws', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Bad() { useToasts(); return null; }
    expect(() => render(<Bad />)).toThrow();
    spy.mockRestore();
  });
});

describe('ProgressRow', () => {
  it('determinate exposes value and clamps', () => {
    const { rerender } = render(<ProgressRow label="Repair" value={0.4} />);
    const bar = screen.getByRole('progressbar', { name: 'Repair' });
    expect(bar.getAttribute('aria-valuenow')).toBe('0.4');
    expect(screen.getByText('40%')).toBeTruthy();
    rerender(<ProgressRow label="Repair" value={3} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
  });
  it('indeterminate has no valuenow; cancel fires', () => {
    const fn = vi.fn();
    render(<ProgressRow label="Loading" onCancel={fn} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.hasAttribute('aria-valuenow')).toBe(false);
    expect(bar.className).toContain('mx-indeterminate');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fn).toHaveBeenCalled();
  });
});

describe('KeyCaps', () => {
  it('renders one kbd per key', () => {
    const { container } = render(<KeyCaps shortcut="Ctrl+Shift+Z" />);
    expect(Array.from(container.querySelectorAll('kbd')).map((k) => k.textContent)).toEqual(['Ctrl', 'Shift', 'Z']);
    expect(container.textContent).toBe('Ctrl+Shift+Z');
  });
});

describe('Notice', () => {
  it('severity maps to class and role; actions on their own row', () => {
    const fn = vi.fn();
    const { container } = render(<Notice severity="error" actions={[{ label: 'Repair', onClick: fn }]}>Mesh has holes</Notice>);
    const n = screen.getByRole('alert');
    expect(n.className).toContain('mx-notice-error');
    const text = container.querySelector('.mx-notice-text') as HTMLElement;
    const row = container.querySelector('.mx-notice-actions') as HTMLElement;
    expect(text.contains(row)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Repair' }));
    expect(fn).toHaveBeenCalled();
  });
  it('info/warn use status role and no action row without actions', () => {
    const { container } = render(<Notice severity="warn">Heads up</Notice>);
    expect(screen.getByRole('status').className).toContain('mx-notice-warn');
    expect(container.querySelector('.mx-notice-actions')).toBeNull();
  });
});
