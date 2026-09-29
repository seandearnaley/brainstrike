/**
 * BST-1070: the `run_python` result surface.
 *
 * The seam gives four terminal states plus one orthogonal modifier, and this
 * file's job is to keep them distinguishable (design §4):
 *
 * - `killed` is a REAL state (`exitCode: null, timedOut: false` — segfault,
 *   OOM), rendered as neither completed nor "nothing ran";
 * - a non-zero exit code is NOT a tool failure — the tool did its job, the
 *   script returned 1: amber "finished with an error", never the destructive
 *   didn't-run chrome (destructive is reserved for `unavailable`);
 * - cancelled never renders as success and never renders as empty — the
 *   partial streams exist precisely so neither lie is necessary;
 * - truncation is a PER-STREAM note under the affected pane, not a peer
 *   state — a run can be both timed out and truncated on one stream only.
 *
 * `LiveShellOutputPane` is deliberately not reused: it is bottom-pinned
 * (`flex-col-reverse`), the right affordance for a streaming terminal and the
 * wrong one for a finished result — a traceback would open with its first
 * line hidden above the fold. `RunPythonStreamPane` keeps the same class
 * vocabulary but reads top-down as a labelled `<section>` (no longer live).
 *
 * Narrowing and formatters live in `run-python-result-model.ts` so this file
 * exports only components (react-refresh `only-export-components`).
 */
import { AlertCircle, CheckCircle, CircleSlash, Globe, Timer } from 'lucide-react';
import type { ReactElement } from 'react';
import {
  formatOmittedBytes,
  formatRunDuration,
  type RunPythonDisplayResult,
} from './run-python-result-model';

/**
 * The optional cleanup note that rides every arm: present ONLY when the tool
 * could not delete its per-call scratch folder. The tool guarantees "nothing
 * it writes persists", so this failure is surfaced, never swallowed.
 */
interface RunPythonCleanupDisplay {
  readonly scratchCleanupFailed?: unknown;
  readonly scratchDir?: unknown;
}

/**
 * Copy for the didn't-run states, one per typed reason (design §6.4, adjusted
 * to the SHIPPED reason set, which now includes both gate-confirmation
 * refusals and the BST-1097 unrecognized-resume refusal). An unrecognised
 * reason returns `null` and renders the generic headline with the tool's own
 * detail below: a diagnosis this build cannot make is not invented. (A
 * switch, not a keyed record: the reasons are snake_case wire values, not
 * identifiers.)
 */
function unavailableCopy(reason: string): { headline: string; sub?: string } | null {
  switch (reason) {
    case 'approval_confirmation_unavailable':
      return {
        headline:
          'Nothing ran — this script needed your approval and there was no way to ask you for it.',
      };
    case 'resume_unrecognized':
      return {
        headline: "Nothing ran — the answer to this script's prompt couldn't be read.",
        sub: "Ask again and you'll get a fresh prompt.",
      };
    case 'executor_kind_unavailable':
      return {
        headline:
          "Nothing ran — the kind of sandbox this run needs isn't available on this computer.",
      };
    case 'executor_tier_mismatch':
      return {
        headline:
          "Nothing ran — the sandbox couldn't confirm it was actually isolating this script.",
        sub: "That's a setup problem on this machine, not something the script did.",
      };
    case 'interpreter_unavailable':
      return {
        headline: "Nothing ran — the sandbox's Python couldn't be prepared on this machine.",
      };
    case 'language_unsupported':
      return { headline: "Nothing ran — this sandbox can't run Python." };
    case 'network_confirmation_unavailable':
      return {
        headline:
          'Nothing ran — this script wanted internet access and there was no way to ask you about it.',
      };
    case 'network_unsupported':
      return {
        headline:
          "Nothing ran — this sandbox can't give the script internet access, and the script needed it.",
        sub: 'Running it offline would have finished "successfully" with missing data, so it wasn\'t run at all.',
      };
    case 'no_sandbox_configured':
      return {
        headline: "Nothing ran — there's no sandbox to run Python in.",
        sub: 'Python runs here once a sandbox is installed.',
      };
    case 'resolve_timed_out':
      return {
        headline: 'Nothing ran — getting the sandbox ready used up the whole time limit.',
        sub: 'The first run can be slow while Python is set up; try again or raise the time limit.',
      };
    default:
      return null;
  }
}

/** The muted "why there's no exit code" line for signal-terminated runs. */
function signalLine(signal: string | null, killedExtra: boolean): string {
  const base = signal
    ? `It was ended by ${signal}, so there's no exit code.`
    : // Defensive only: the seam rules a null signal a backend contract
      // violation, but a misbehaving backend must still render something true
      // rather than "ended by null".
      "It was ended before it finished, so there's no exit code.";
  return killedExtra
    ? `${base} Out of memory or a crash inside a Python package are the usual causes.`
    : base;
}

function RunPythonStreamPane({
  label,
  omittedBytes,
  testId,
  text,
}: {
  label: string;
  omittedBytes: number;
  testId: string;
  text: string;
}): ReactElement | null {
  if (text.length === 0 && omittedBytes === 0) {
    return null;
  }
  return (
    <div className="px-2 pb-1.5">
      <p className="mb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
        {label}
      </p>
      {text.length > 0 ? (
        <section
          aria-label={label}
          className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 font-mono text-[11px] leading-relaxed"
          data-testid={testId}
        >
          {text}
        </section>
      ) : null}
      {omittedBytes > 0 ? (
        <p
          className="mt-1 text-amber-700 text-xs dark:text-amber-400"
          data-testid={`${testId}-omitted`}
        >
          {/* The seam reports a count, not a position — never claim WHERE the
              drop happened. */}
          Output was too long — {formatOmittedBytes(omittedBytes)} wasn't captured.
        </p>
      ) : null}
    </div>
  );
}

interface RunPythonHeaderSpec {
  readonly icon: ReactElement;
  readonly state: string;
  readonly text: string;
}

function resolveHeader(result: RunPythonDisplayResult): RunPythonHeaderSpec {
  const amber = 'size-4 text-amber-700 dark:text-amber-400';
  switch (result.kind) {
    case 'completed': {
      if (result.exitCode !== 0) {
        return {
          icon: <AlertCircle className={amber} />,
          state: 'completed-nonzero',
          text: `Finished with an error (exit code ${result.exitCode}).`,
        };
      }
      const silent =
        result.stdout.length === 0 &&
        result.stderr.length === 0 &&
        result.stdoutOmittedBytes === 0 &&
        result.stderrOmittedBytes === 0;
      return {
        icon: <CheckCircle className="size-4 text-green-600 dark:text-green-500" />,
        state: 'completed',
        text: silent ? "Finished — the script didn't print anything." : 'Finished',
      };
    }
    case 'timed_out':
      return {
        icon: <Timer className={amber} />,
        state: 'timed_out',
        text: `Stopped after ${formatRunDuration(result.timeoutMs)} — the script was still running.`,
      };
    case 'killed':
      return {
        icon: <AlertCircle className={amber} />,
        state: 'killed',
        text: 'The script was stopped by the system before it finished.',
      };
    case 'network_denied':
      // The user's choice, honestly stated — not a failure and not empty.
      // Design §4.4: Globe, muted; the model sees deniedDomains and can
      // rewrite the script to work offline.
      return {
        icon: <Globe className="size-4 text-muted-foreground" />,
        state: 'network_denied',
        text: "You didn't allow internet access, so the script didn't run.",
      };
    case 'declined':
      // Gate A declined (BST-1097): the user's choice, same muted treatment
      // as network_denied — not a failure, never destructive chrome.
      return {
        icon: <CircleSlash className="size-4 text-muted-foreground" />,
        state: 'declined',
        text: "You didn't approve this, so the script didn't run.",
      };
    case 'cancelled': {
      const silent =
        result.partialStdout.length === 0 &&
        result.partialStderr.length === 0 &&
        result.stdoutOmittedBytes === 0 &&
        result.stderrOmittedBytes === 0;
      return {
        icon: <CircleSlash className="size-4 text-muted-foreground" />,
        state: 'cancelled',
        text: silent
          ? 'You stopped this before the script printed anything.'
          : "You stopped this. Here's what it printed before it stopped.",
      };
    }
    default: {
      const copy = unavailableCopy(result.reason);
      return {
        icon: <AlertCircle className="size-4 text-destructive" />,
        state: 'unavailable',
        text: copy?.headline ?? 'Nothing ran.',
      };
    }
  }
}

interface RunPythonSurfaceModel {
  readonly secondaryLines: readonly string[];
  readonly stderr: string;
  /** stderr leads for a crashed script — the traceback is the story. */
  readonly stderrLeads: boolean;
  readonly stderrOmittedBytes: number;
  readonly stdout: string;
  readonly stdoutLabel: string;
  readonly stdoutOmittedBytes: number;
}

/** Pure per-state projection so the component itself stays branch-light. */
function resolveSurfaceModel(result: RunPythonDisplayResult): RunPythonSurfaceModel {
  switch (result.kind) {
    case 'cancelled':
      return {
        secondaryLines: [],
        stderr: result.partialStderr,
        stderrLeads: false,
        stderrOmittedBytes: result.stderrOmittedBytes,
        stdout: result.partialStdout,
        stdoutLabel: 'Partial output',
        stdoutOmittedBytes: result.stdoutOmittedBytes,
      };
    case 'timed_out':
    case 'killed':
      return {
        secondaryLines: [signalLine(result.signal, result.kind === 'killed')],
        stderr: result.stderr,
        stderrLeads: false,
        stderrOmittedBytes: result.stderrOmittedBytes,
        stdout: result.stdout,
        stdoutLabel: 'Output before it was stopped',
        stdoutOmittedBytes: result.stdoutOmittedBytes,
      };
    case 'declined':
    case 'network_denied':
      return {
        secondaryLines: [],
        stderr: '',
        stderrLeads: false,
        stderrOmittedBytes: 0,
        stdout: '',
        stdoutLabel: 'Output',
        stdoutOmittedBytes: 0,
      };
    case 'unavailable': {
      const copy = unavailableCopy(result.reason);
      return {
        // A recognised reason gets its curated sub-line; an unrecognised one
        // gets the tool's own detail — never both, never an invented line.
        secondaryLines: copy ? (copy.sub ? [copy.sub] : []) : [result.detail],
        stderr: '',
        stderrLeads: false,
        stderrOmittedBytes: 0,
        stdout: '',
        stdoutLabel: 'Output',
        stdoutOmittedBytes: 0,
      };
    }
    default:
      return {
        secondaryLines: [],
        stderr: result.stderr,
        stderrLeads: result.exitCode !== 0,
        stderrOmittedBytes: result.stderrOmittedBytes,
        stdout: result.stdout,
        stdoutLabel: 'Output',
        stdoutOmittedBytes: result.stdoutOmittedBytes,
      };
  }
}

/**
 * The structured result region for a settled `run_python` call. Mounted by
 * `tool-fallback-body.tsx` between the header row and the raw-JSON details
 * pane; the raw pane still holds the untouched result object.
 */
export function RunPythonResultSurface({
  result,
}: {
  result: RunPythonDisplayResult & RunPythonCleanupDisplay;
}): ReactElement {
  const header = resolveHeader(result);
  const model = resolveSurfaceModel(result);
  const cleanupDir =
    result.scratchCleanupFailed === true && typeof result.scratchDir === 'string'
      ? result.scratchDir
      : null;

  const stdoutPane = (
    <RunPythonStreamPane
      label={model.stdoutLabel}
      omittedBytes={model.stdoutOmittedBytes}
      testId="run-python-stdout"
      text={model.stdout}
    />
  );
  const stderrPane = (
    <RunPythonStreamPane
      label="Errors"
      omittedBytes={model.stderrOmittedBytes}
      testId="run-python-stderr"
      text={model.stderr}
    />
  );

  return (
    <div data-state={header.state} data-testid="run-python-result-state">
      <div className="flex items-start gap-2 px-2 pt-1 pb-1.5">
        <span aria-hidden="true" className="pt-0.5">
          {header.icon}
        </span>
        <div className="min-w-0 text-xs">
          <p className="font-medium" data-testid="run-python-result-header">
            {header.text}
          </p>
          {model.secondaryLines.map((line) => (
            <p className="mt-0.5 text-muted-foreground" key={line}>
              {line}
            </p>
          ))}
        </div>
      </div>
      {model.stderrLeads ? (
        <>
          {stderrPane}
          {stdoutPane}
        </>
      ) : (
        <>
          {stdoutPane}
          {stderrPane}
        </>
      )}
      {cleanupDir ? (
        <p
          className="px-2 pb-1.5 text-amber-700 text-xs dark:text-amber-400"
          data-testid="run-python-cleanup-failed"
        >
          The run's temporary folder couldn't be deleted:{' '}
          <span className="font-mono [overflow-wrap:anywhere]">{cleanupDir}</span>
        </p>
      ) : null}
    </div>
  );
}
