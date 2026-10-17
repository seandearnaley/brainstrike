import { render, screen } from '@testing-library/react';
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
    const { container } = render(
      <Combined>
        <span data-leaf="leaf" />
      </Combined>
    );
    expect(
      container.querySelector('[data-wrapper="A"] > [data-wrapper="B"] > [data-leaf="leaf"]')
    ).not.toBeNull();
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
    expect(document.querySelector('[data-wrapper]')).not.toBeNull();
    expect(screen.getByText('hello world')).toBeInstanceOf(HTMLElement);

    // NoopWrapper should simply return its child
    const { container } = render(
      <NoopWrapper>
        <p data-test="noop" />
      </NoopWrapper>
    );
    expect(container.querySelector('p[data-test="noop"]')).not.toBeNull();
  });
});
