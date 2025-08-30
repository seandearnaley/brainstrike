// Minimal, dependency-light helpers for composing test render wrappers
// Avoid direct React/Testing Library type dependencies to keep build lean.

import { createRequire } from 'node:module';
import type { ComponentType, ReactElement, ReactNode } from 'react';

type AnyProps = { children?: ReactNode };
type AnyWrapper = (props: AnyProps) => ReactElement | null;

type RenderFunction = (ui: ReactElement, options?: Record<string, unknown>) => unknown;

let rtlRender: RenderFunction | undefined;
// Prefer Node's createRequire to avoid top-level await (ES2020 target)
try {
  const req = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  rtlRender = (req('@testing-library/react') as { render: RenderFunction }).render;
} catch {
  // Leave undefined; the helper will throw with a clear message when used
}

export type RenderOptions = Record<string, unknown>;

export function composeWrappers(...wrappers: AnyWrapper[]): AnyWrapper {
  return ({ children }: AnyProps) => {
    const reduced = wrappers.reduceRight<ReactNode>(
      (acc, Wrapper) => Wrapper({ children: acc }),
      children
    );
    // Ensure a ReactElement is returned to satisfy AnyWrapper
    return (reduced as unknown as ReactElement) ?? null;
  };
}

export function makeRenderWithProviders(Wrapper: AnyWrapper) {
  return function renderWithProviders(ui: ReactElement, options?: RenderOptions) {
    if (!rtlRender) throw new Error('Testing Library not available in this environment');
    return rtlRender(ui, {
      wrapper: Wrapper as ComponentType<{ children: ReactNode }>,
      ...options,
    });
  };
}

export function NoopWrapper({ children }: AnyProps): ReactElement | null {
  return (children as unknown as ReactElement) ?? null;
}
