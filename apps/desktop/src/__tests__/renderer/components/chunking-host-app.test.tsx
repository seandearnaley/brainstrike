// @vitest-environment jsdom
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../renderer/components/desktop-chunking-worker-provider', () => ({
  DesktopChunkingWorkerProvider: ({ children }: { readonly children: ReactNode }) => children,
}));

import { ChunkingHostApp } from '../../../renderer/components/chunking-host-app';

describe('ChunkingHostApp', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/?mode=chunking-host');
  });

  it('contains a render boundary for missing runtime ids', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => {
      render(<ChunkingHostApp />);
    }).not.toThrow();

    consoleErrorSpy.mockRestore();
  });
});
