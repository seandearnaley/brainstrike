import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const loadModule = async () => import('../render-with-providers.js');

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.doUnmock('node:module');
  vi.doUnmock('@testing-library/react');
});

describe('render-with-providers helpers', () => {
  it('composeWrappers nests providers from right to left', async () => {
    const { composeWrappers } = await loadModule();
    const WrapperA = ({ children }: { children?: React.ReactNode }) => (
      <div data-wrapper="A">{children}</div>
    );
    const WrapperB = ({ children }: { children?: React.ReactNode }) => (
      <section data-wrapper="B">{children}</section>
    );

    const Combined = composeWrappers(WrapperA, WrapperB);
    const output = Combined({ children: <span data-leaf="leaf" /> });

    expect(output.props['data-wrapper']).toBe('A');
    expect(output.props.children.props['data-wrapper']).toBe('B');
    expect(output.props.children.props.children.props['data-leaf']).toBe('leaf');
  });

  it('makeRenderWithProviders renders content via Testing Library', async () => {
    const { makeRenderWithProviders, NoopWrapper } = await loadModule();
    const Wrapper = ({ children }: { children?: React.ReactNode }) => (
      <div data-wrapper>{children}</div>
    );

    const renderWithProviders = makeRenderWithProviders(Wrapper);
    const result = renderWithProviders(<span>hello world</span>);

    expect(result).toMatchObject({
      container: expect.any(HTMLElement),
    });
    expect(result.container.querySelector('[data-wrapper]')).not.toBeNull();
    expect(result.getByText('hello world')).toBeInstanceOf(HTMLElement);

    // NoopWrapper should simply return its child
    const noopResult = NoopWrapper({ children: <p data-test="noop" /> });
    expect(noopResult?.props['data-test']).toBe('noop');
  });
});
