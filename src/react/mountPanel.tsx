import { Component, type ErrorInfo, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { reportError } from '../ui/Status.js';
import { useT } from './useT.ts';

type Reporter = (err: unknown, opts?: { title?: string }) => void;

export class PanelErrorBoundary extends Component<
  { children: ReactNode; reporter?: Reporter; title?: string },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown, _info: ErrorInfo) {
    (this.props.reporter ?? reportError)(error, { title: this.props.title });
  }
  render() { return this.state.failed ? null : this.props.children; }
}

/** Single shared provider: re-renders the tree on locale change. */
function Provider({ children }: { children: ReactNode }) {
  useT();
  return <>{children}</>;
}

const roots = new Map<string, { root: Root; el: HTMLElement }>();

/** Mount a React panel into the element with id rootId. Idempotent per root; returns unmount(). */
export function mountPanel(rootId: string, element: ReactElement, reporter?: Reporter): () => void {
  const el = document.getElementById(rootId);
  if (!el) throw new Error(`mountPanel: #${rootId} not found`);
  const existing = roots.get(rootId);
  if (existing && existing.el === el) return () => unmount(rootId);
  if (existing) unmount(rootId);
  const root = createRoot(el);
  roots.set(rootId, { root, el });
  root.render(
    <PanelErrorBoundary reporter={reporter} title={rootId}>
      <Provider>{element}</Provider>
    </PanelErrorBoundary>,
  );
  return () => unmount(rootId);
}

function unmount(rootId: string) {
  const entry = roots.get(rootId);
  if (!entry) return;
  roots.delete(rootId);
  entry.root.unmount();
}
