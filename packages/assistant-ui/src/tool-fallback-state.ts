/**
 * The tool card's pure state derivations: which activity state its glyph
 * shows, which structured `run_python` payload (if any) may render beneath the
 * row, which error line it paints, and the two small readers the row/body use
 * to format what came back.
 *
 * Split out of `tool-fallback.tsx` (BST-1684) so the card file exports only
 * components and so these rulings can be read without the JSX around them.
 * Nothing here touches React.
 */
import type { ToolCallMessagePartComponent } from '@assistant-ui/react';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract/tool-metadata';
import type { ComponentProps } from 'react';
import {
  type ActivityStepState,
  readToolFailure,
  runPythonStepState,
  toolStepStateFor,
} from './activity-trace-model';
import { readDelegatedTaskTerminalError } from './delegated-terminal-status';
import {
  narrowRunPythonDisplayResult,
  type RunPythonDisplayResult,
} from './run-python-result-model';

type ToolFallbackProps = ComponentProps<ToolCallMessagePartComponent>;
export type ToolStatus = ToolFallbackProps['status'];
export type ToolResult = ToolFallbackProps['result'];

/**
 * The card's state, and the structured `run_python` result it may render
 * beneath the row.
 *
 * The state is `toolStepStateFor` and nothing else — the SAME derivation the
 * trace headline, the step rows and the task-list/subagent cards read. The
 * two readings this card used to layer on top of it (the declined envelope,
 * and `run_python`'s own five-arm mapping) moved INTO that function in
 * BST-1681 phase 3: while they lived here a declined call read `Stopped` on
 * the card and `Completed` in the headline at the same time. There is no
 * card-only state left to resolve.
 *
 * The narrowing survives here for RENDERING only, gated by an IDENTITY check:
 * the structured surface renders exactly when this result is what PRODUCED
 * the card's state — i.e. `runPythonStepState` of it equals the state on
 * screen. That is not the same as "never under non-`done` chrome", and
 * deliberately so: a settled run whose own payload reads `unavailable` DOES
 * show its surface under failed chrome, and one reading `timed_out`/`killed`
 * under stopped chrome, because in each case that payload IS the reason for
 * the state and is the detail the user came for. What the check excludes is a
 * surface that would explain something else — a still-running
 * or approval-gated call shows none however complete its payload looks, and a
 * transport abort keeps its own error line instead of a stale success pane.
 */
export function resolveCardStatus(
  toolName: string,
  status: ToolStatus,
  result: ToolResult,
  isErrorResult: boolean
): { glyphState: ActivityStepState; runPythonResult: RunPythonDisplayResult | null } {
  const glyphState = toolStepStateFor({ isError: isErrorResult, result, status, toolName });
  const narrowed =
    toolName === NATIVE_TOOL_ID.runPython ? narrowRunPythonDisplayResult(result) : null;
  return {
    glyphState,
    runPythonResult: narrowed && runPythonStepState(narrowed) === glyphState ? narrowed : null,
  };
}

const isIncompleteStatus = (
  status: ToolStatus
): status is ToolStatus & { type: 'incomplete'; error?: unknown; reason?: unknown } =>
  status.type === 'incomplete';

/**
 * The card's error LINE, from the same reader the state machine uses.
 *
 * `readResultError` (`activity-trace-model.ts`) is the only place that decides
 * what "this result states an error" means, so the line the card paints and
 * the `failed` verdict the trace counts can never disagree about a shape
 * (bot round 1, Claude Important 2 — the card's own copy of the shape list had
 * already drifted on `ok: true`). The part-level `isError` flag stays a
 * SEPARATE signal (`readToolFailure`): an errored part's string result is the
 * AI SDK tool-error's own message, and only an errored part that states
 * nothing takes the generic one.
 */
export const resolveErrorMessage = (
  status: ToolStatus,
  result: ToolResult,
  isErrorResult: boolean
): string | undefined => {
  if (!isIncompleteStatus(status)) {
    return readToolFailure(result, isErrorResult) ?? undefined;
  }

  if (typeof status.error === 'string') {
    return status.error;
  }

  const delegatedTerminal = readDelegatedTaskTerminalError(status.error);
  if (delegatedTerminal) {
    return delegatedTerminal.message;
  }

  if (status.error !== undefined) {
    try {
      return JSON.stringify(status.error);
    } catch {
      return String(status.error);
    }
  }

  if (typeof result === 'string') {
    return result;
  }

  if (status.reason !== undefined) {
    return `Tool incomplete: ${String(status.reason)}`;
  }

  return 'Tool incomplete: unknown';
};

export const formatResult = (result: ToolResult): string => {
  if (typeof result === 'string') {
    return result;
  }
  if (result === undefined) {
    return '';
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
};

export function extractResolvedRootName(result: ToolResult): string | undefined {
  if (!(result && typeof result === 'object' && !Array.isArray(result))) {
    return;
  }
  const rootName = (result as Record<string, unknown>)['rootName'];
  return typeof rootName === 'string' && rootName.trim() ? rootName.trim() : undefined;
}
