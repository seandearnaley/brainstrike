import {
  MCP_PROGRESS_STREAM_PART_TYPE,
  SHELL_OUTPUT_STREAM_PART_TYPE,
  TOOL_TELEMETRY_OMITTED_TYPE,
} from '@brainstrike/assistant-contract';
import { act, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { LiveShellOutputPane } from '../live-shell-output-pane';
import { LiveShellOutputContext, LiveShellOutputs } from '../live-shell-outputs';
import { useShellOutputs } from '../use-shell-outputs';

/** The chunk a command's tool writer sends, as `run/telemetry` delivers it. */
const slice = (toolCallId: string, chunk: string) => ({
  chunk,
  stream: 'stdout',
  toolCallId,
  type: SHELL_OUTPUT_STREAM_PART_TYPE,
});

describe('a host thread’s live shell output', () => {
  it('accumulates telemetry slices by tool call and clears them when the result commits', () => {
    const live = new LiveShellOutputs();
    const wrapper = ({ children }: { readonly children: ReactNode }) => (
      <LiveShellOutputContext value={live}>{children}</LiveShellOutputContext>
    );
    const { result } = renderHook(() => useShellOutputs('answer', []), { wrapper });
    expect(result.current).toEqual({});

    act(() => {
      live.accept(slice('command-1', 'first\n'));
      live.accept({
        progress: 1,
        toolCallId: 'command-1',
        total: 2,
        type: MCP_PROGRESS_STREAM_PART_TYPE,
      });
      live.accept(slice('command-1', 'second\n'));
    });
    expect(result.current).toEqual({
      'command-1': { text: 'first\nsecond\n', truncated: false },
    });

    act(() => live.clear('command-1'));
    expect(result.current).toEqual({});
  });

  it('shows that a replay dropped a running command’s earliest output', () => {
    const live = new LiveShellOutputs();
    const wrapper = ({ children }: { readonly children: ReactNode }) => (
      <LiveShellOutputContext value={live}>{children}</LiveShellOutputContext>
    );
    const { result } = renderHook(() => useShellOutputs('answer', []), { wrapper });
    act(() => {
      live.accept({
        omittedBytes: 3000,
        resumesAt: 2,
        toolCallId: 'command-1',
        type: TOOL_TELEMETRY_OMITTED_TYPE,
      });
      live.accept(slice('command-1', 'tail\n'));
    });
    expect(result.current).toEqual({
      'command-1': { omittedBytes: 3000, text: 'tail\n', truncated: false },
    });

    render(<LiveShellOutputPane omittedBytes={3000} text="tail" truncated={false} />);
    expect(screen.getByText('Earlier output not shown (3 KB)')).toBeTruthy();
  });
});
