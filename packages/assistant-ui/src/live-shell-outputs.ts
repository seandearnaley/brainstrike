import { readShellOutputStreamPart } from '@brainstrike/assistant-contract/shell-output';
import { createContext } from 'react';
import type { ShellOutputAccumulation } from './shell-output-parts';

const NONE: Readonly<Record<string, ShellOutputAccumulation>> = {};

/**
 * A host thread's live shell output, keyed by tool call. The host sends a
 * running command's slices as uncommitted telemetry (ADR-0011 amendment), so
 * they exist only here; when the tool's result commits, the result owns the
 * output and the slices are cleared. A reload shows none, as legacy did.
 */
export class LiveShellOutputs {
  private outputs = NONE;
  private readonly listeners = new Set<() => void>();

  readonly getSnapshot = (): Readonly<Record<string, ShellOutputAccumulation>> => this.outputs;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * One telemetry chunk. Only a readable shell slice accumulates: MCP progress
   * renders nothing (legacy parity), and a slice that names no tool call, pipe
   * or text is never attributed to a card.
   */
  accept(chunk: unknown): void {
    const slice = readShellOutputStreamPart(chunk);
    if (!slice) {
      return;
    }
    const existing = this.outputs[slice.toolCallId] ?? { text: '', truncated: false };
    this.publish({
      ...this.outputs,
      [slice.toolCallId]: {
        text: existing.text + slice.chunk,
        truncated: existing.truncated || slice.truncated === true,
      },
    });
  }

  /** The tool call's result committed: it owns the output from here on. */
  clear(toolCallId: string): void {
    if (!(toolCallId in this.outputs)) {
      return;
    }
    const { [toolCallId]: _cleared, ...rest } = this.outputs;
    this.publish(Object.keys(rest).length === 0 ? NONE : rest);
  }

  private publish(outputs: Readonly<Record<string, ShellOutputAccumulation>>): void {
    this.outputs = outputs;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/** The conversation's live shell output; absent where its transport streams parts instead. */
export const LiveShellOutputContext = createContext<LiveShellOutputs | null>(null);
