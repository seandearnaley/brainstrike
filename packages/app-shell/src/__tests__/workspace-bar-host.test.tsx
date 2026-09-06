import { act, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChangesLiveRefreshStore } from '../changes/changes-live-refresh-store';
import type { UseWorkspaceBarArgs } from '../hooks/use-workspace-bar';
import { WorkspaceBarHost } from '../workspace-bar/workspace-bar-host';

const { renders } = vi.hoisted(() => ({ renders: { bar: 0, parent: 0, probe: 0 } }));

// Minimal on purpose: nothing in this import graph needs a VALUE from
// @brainstrike/assistant-ui except the bar itself (everything else is
// type-only), and the bar's own rendering is covered in that package.
vi.mock('@brainstrike/assistant-ui', () => ({
  WorkspaceBar: (): ReactElement => {
    renders.bar += 1;
    return <div data-testid="bar" />;
  },
}));
vi.mock('@brainstrike/file-explorer-ui/shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/file-explorer-ui/shell')>()),
  useFileSystem: () => ({
    addRootDirectory: vi.fn(),
    // BST-1393 L2: useConnectFolder() (now reached via useFolderDrop() inside
    // useWorkspaceBar()) calls this unconditionally to gate openPicker.
    isFileSystemAccessSupported: () => ({ reason: '', supported: true }),
  }),
}));

// Module-level, so its identity is stable across parent renders — exactly what
// the wrapper passes (store values, the db handle, ids).
const ARGS: UseWorkspaceBarArgs = {
  assistantThreadRepository: null,
  database: null,
  memoryResourceId: 'workspace-a',
  rootDescriptors: undefined,
  selectedMemoryThreadId: undefined,
};

function Probe(): ReactElement {
  renders.probe += 1;
  return <span data-testid="probe" />;
}

/**
 * Stands in for the assistant panel wrapper: it renders the bar host as one
 * child among others, and re-renders for reasons of its own (`tick`).
 */
function Parent({ tick }: { readonly tick: number }): ReactElement {
  renders.parent += 1;
  return (
    <>
      <WorkspaceBarHost {...ARGS} />
      <Probe />
      <span data-testid="tick">{tick}</span>
    </>
  );
}

beforeEach(() => {
  useChangesLiveRefreshStore.getState().reset();
  renders.bar = 0;
  renders.parent = 0;
  renders.probe = 0;
});

/**
 * A wrapper-level render-count test is impractical here — mounting
 * `AssistantUiPanelWrapper` needs the whole provider/runtime harness, and its
 * own render count is dominated by streaming state. This harness pins the same
 * invariant at the seam that actually decides it: the subscription lives in the
 * host, and the host is memoized.
 */
describe('WorkspaceBarHost', () => {
  it('absorbs a live-refresh signal without re-rendering its siblings', () => {
    render(<Parent tick={0} />);
    expect(renders.bar).toBe(1);
    const parentRenders = renders.parent;
    const probeRenders = renders.probe;

    act(() => {
      useChangesLiveRefreshStore.getState().ingestInvalidation({
        generation: 1,
        gitCommonDir: '/ws/a/.git',
        repositoryRoot: '/ws/a',
      });
    });

    // The bar owns the subscription, so only the bar re-renders. Before the
    // host existed this same signal re-rendered the whole panel wrapper.
    expect(renders.bar).toBe(2);
    expect(renders.parent).toBe(parentRenders);
    expect(renders.probe).toBe(probeRenders);
  });

  it('does not re-render when the parent re-renders with unchanged args', () => {
    const { rerender } = render(<Parent tick={0} />);
    expect(renders.bar).toBe(1);

    rerender(<Parent tick={1} />);

    expect(renders.parent).toBe(2);
    expect(renders.probe).toBe(2);
    expect(renders.bar).toBe(1);
  });
});
