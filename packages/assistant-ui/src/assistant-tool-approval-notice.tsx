import { type CreateAppendMessage, useAui, useAuiState } from '@assistant-ui/react';
import {
  getToolActionIdentityKey,
  getToolActionTarget,
  isDelegatedToolActionIdentity,
  isMatchingToolAction,
} from '@brainstrike/assistant-contract';
import type {
  AssistantToolApprovalAction,
  AssistantToolApprovalDecision,
  AssistantToolApprovalRequest,
  CodeExecutionApprovalContext,
} from '@brainstrike/assistant-contract/tool-approval';
import {
  isCodeExecutionApprovalContext,
  TOOL_APPROVAL_RUN_CONFIG_KEY,
} from '@brainstrike/assistant-contract/tool-approval';
import {
  isToolRiskCategory,
  NATIVE_TOOL_ID,
  type ToolRiskCategory,
} from '@brainstrike/assistant-contract/tool-metadata';
import { createLogger } from '@brainstrike/logging';
import {
  Badge,
  Button,
  CodeSurface,
  DiffView,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@brainstrike/ui';
import { AlertTriangle, Check, ChevronDown, ChevronUp, ShieldCheck, Timer, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { readRediscoveredPauseDisplay } from './rediscovered-pause-display';
import { RediscoveredPauseLines } from './rediscovered-pause-lines';
import { formatRunDuration } from './run-python-result-model';
import { useToolApprovalGrants } from './tool-approval-grant-context';

const logger = createLogger('AssistantToolApprovalNotice');

/**
 * Character cap applied to each large text field (`oldStr`/`newStr`/`content`)
 * before it is handed to the CodeMirror-backed `DiffView`/`CodeSurface`
 * previews. The agent schema allows these fields up to 8,000,000 chars each
 * (`packages/agent/src/tools/schemas.ts`); mounting that much text into
 * CodeMirror would jank the renderer BEFORE the user can even approve or
 * decline. Truncation is always visible (a note names the shown/total char
 * counts below the preview) — the raw JSON expander further down always has
 * the untruncated value, so nothing is silently dropped.
 */
export const APPROVAL_PREVIEW_CHAR_CAP = 100_000;

/**
 * Registered ids of tools whose approval cards render a structured preview
 * instead of raw JSON. These are the sanitized-name-resolved ids the approval
 * chunk carries (see `makeApprovalRequiredChunks` in the agent runtime), NOT
 * the model-facing names.
 */
const EXECUTE_COMMAND_TOOL_ID = NATIVE_TOOL_ID.executeCommand;
const RUN_PYTHON_TOOL_ID = NATIVE_TOOL_ID.runPython;
const RUN_SKILL_SCRIPT_TOOL_ID = NATIVE_TOOL_ID.runSkillScript;
const STRING_REPLACE_TOOL_ID = NATIVE_TOOL_ID.stringReplaceWorkspaceFile;
const WRITE_FILE_TOOL_ID = NATIVE_TOOL_ID.writeWorkspaceFile;
const EXECUTE_COMMAND_ARG_KEYS = new Set(['command', 'cwd', 'root', 'timeoutMs']);
const RUN_PYTHON_ARG_KEYS = new Set(['allowedDomains', 'code', 'timeoutMs']);
// Local literals mirroring the agent seam's MAX_EXEC_CODE_LENGTH /
// MAX_EXEC_TIMEOUT_MS (packages/agent/src/code-execution.ts). The UI package
// does not depend on @brainstrike/agent — the same trade the other narrowers
// in this file make.
const RUN_PYTHON_MAX_CODE_CHARS = 1_000_000;
const RUN_PYTHON_MAX_TIMEOUT_MS = 600_000;
// Mirrors MAX_POLICY_ENTRIES / MAX_POLICY_DOMAIN_LENGTH. Domain SHAPE is NOT
// re-validated here — the seam's policyDomainSchema is authoritative and a
// second drifting regex would be a way to disagree with the thing that
// actually enforces it (design §2.5); this narrowing only bounds size.
const RUN_PYTHON_MAX_DOMAINS = 256;
const RUN_PYTHON_MAX_DOMAIN_CHARS = 253;
const RUN_SKILL_SCRIPT_ARG_KEYS = new Set([
  'args',
  'cwd',
  'root',
  'runtime',
  'scriptPath',
  'skillName',
  'timeoutMs',
]);

interface AssistantToolApprovalNoticeProps {
  data: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

interface StringReplaceApprovalArgs {
  newStr: string;
  oldStr: string;
  path: string;
  root?: string;
}

interface WriteFileApprovalArgs {
  content: string;
  path: string;
  root?: string;
}

interface ExecuteCommandApprovalArgs {
  command: string;
  cwd?: string;
  root?: string;
  timeoutMs?: number;
}

interface RunSkillScriptApprovalArgs {
  args?: readonly string[];
  cwd: string;
  root: string;
  runtime: 'bash' | 'node' | 'python3';
  scriptPath: string;
  skillName: string;
  timeoutMs?: number;
}

function isCanonicalRelativePath(value: string): boolean {
  return (
    value === '.' ||
    (value.length > 0 &&
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !/^[A-Za-z]:/.test(value) &&
      value
        .split('/')
        .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'))
  );
}

function narrowRunSkillScriptArgs(value: unknown): RunSkillScriptApprovalArgs | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !RUN_SKILL_SCRIPT_ARG_KEYS.has(key))) {
    return null;
  }
  const { args, cwd, root, runtime, scriptPath, skillName, timeoutMs } = value;
  if (
    typeof cwd !== 'string' ||
    cwd.length > 1000 ||
    !isCanonicalRelativePath(cwd) ||
    typeof root !== 'string' ||
    root.length === 0 ||
    root.length > 500 ||
    (runtime !== 'bash' && runtime !== 'node' && runtime !== 'python3') ||
    typeof scriptPath !== 'string' ||
    scriptPath.length > 1000 ||
    !scriptPath.startsWith('scripts/') ||
    !isCanonicalRelativePath(scriptPath) ||
    typeof skillName !== 'string' ||
    !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(skillName) ||
    (args !== undefined &&
      (!Array.isArray(args) ||
        args.length > 64 ||
        !args.every((argument) => typeof argument === 'string' && argument.length <= 2000) ||
        args.reduce(
          (total, argument) => total + (typeof argument === 'string' ? argument.length : 0),
          0
        ) > 16_000)) ||
    (timeoutMs !== undefined &&
      (typeof timeoutMs !== 'number' ||
        !Number.isInteger(timeoutMs) ||
        timeoutMs <= 0 ||
        timeoutMs > 600_000))
  ) {
    return null;
  }
  return {
    ...(Array.isArray(args) ? { args: args as string[] } : {}),
    cwd,
    root,
    runtime,
    scriptPath,
    skillName,
    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
  };
}

/**
 * Structural guard mirroring the strict agent-package `ExecuteCommandInput`
 * schema. The command preview is security-sensitive, so this validates every
 * field and rejects unknown keys instead of guessing what will execute.
 */
function narrowExecuteCommandArgs(value: unknown): ExecuteCommandApprovalArgs | null {
  if (!isRecord(value)) {
    return null;
  }
  if (Object.keys(value).some((key) => !EXECUTE_COMMAND_ARG_KEYS.has(key))) {
    return null;
  }

  const { command, cwd, root, timeoutMs } = value;
  if (typeof command !== 'string' || command.length === 0 || command.length > 10_000) {
    return null;
  }
  if (cwd !== undefined && typeof cwd !== 'string') {
    return null;
  }
  if (root !== undefined && typeof root !== 'string') {
    return null;
  }
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 600_000)
  ) {
    return null;
  }

  return {
    command,
    ...(typeof cwd === 'string' ? { cwd } : {}),
    ...(typeof root === 'string' ? { root } : {}),
    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
  };
}

/**
 * Structural guard mirroring the agent-package `StringReplaceWorkspaceFileInput`
 * shape. The UI package does not depend on `@brainstrike/agent`, so this is a
 * minimal local narrowing (path/oldStr/newStr strings, optional root) rather than
 * a shared zod parse. A failure returns `null` so the card falls back to the raw
 * JSON view with a visible note — never a confidently-wrong empty diff.
 */
function narrowStringReplaceArgs(value: unknown): StringReplaceApprovalArgs | null {
  if (!isRecord(value)) {
    return null;
  }
  const { path, oldStr, newStr, root } = value;
  if (typeof path !== 'string' || path.length === 0) {
    return null;
  }
  if (typeof oldStr !== 'string' || typeof newStr !== 'string') {
    return null;
  }
  if (root !== undefined && typeof root !== 'string') {
    return null;
  }
  return { newStr, oldStr, path, ...(typeof root === 'string' ? { root } : {}) };
}

/** Structural guard mirroring the agent-package `WriteWorkspaceFileInput` shape. */
function narrowWriteFileArgs(value: unknown): WriteFileApprovalArgs | null {
  if (!isRecord(value)) {
    return null;
  }
  const { path, content, root } = value;
  if (typeof path !== 'string' || path.length === 0) {
    return null;
  }
  if (typeof content !== 'string') {
    return null;
  }
  if (root !== undefined && typeof root !== 'string') {
    return null;
  }
  return { content, path, ...(typeof root === 'string' ? { root } : {}) };
}

interface RunPythonApprovalArgs {
  readonly allowedDomains?: readonly string[];
  readonly code: string;
  readonly timeoutMs?: number;
}

/**
 * Structural guard mirroring the agent-package `RunPythonInputSchema`
 * (strict: `code` + optional `timeoutMs` + optional `allowedDomains`, nothing
 * else). One deliberate display-side difference: an EMPTY `code` passes here
 * so the card can say "this script is empty" instead of a parse error — the
 * agent schema still rejects it at execute time. An unknown key (e.g. an
 * `unknownField` from a newer build) fails narrowing: a call carrying a field
 * this build does not understand must not be described as if it were
 * understood.
 */
function narrowRunPythonArgs(value: unknown): RunPythonApprovalArgs | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !RUN_PYTHON_ARG_KEYS.has(key))) {
    return null;
  }
  const { allowedDomains, code, timeoutMs } = value;
  if (typeof code !== 'string' || code.length > RUN_PYTHON_MAX_CODE_CHARS) {
    return null;
  }
  if (
    allowedDomains !== undefined &&
    !(
      Array.isArray(allowedDomains) &&
      // [] is the OpenAI-strict-mode spelling of "no network" — valid.
      allowedDomains.length <= RUN_PYTHON_MAX_DOMAINS &&
      allowedDomains.every(
        (domain) =>
          typeof domain === 'string' &&
          domain.trim().length > 0 &&
          domain.length <= RUN_PYTHON_MAX_DOMAIN_CHARS
      )
    )
  ) {
    return null;
  }
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > RUN_PYTHON_MAX_TIMEOUT_MS)
  ) {
    return null;
  }
  return {
    ...(Array.isArray(allowedDomains) ? { allowedDomains: allowedDomains as string[] } : {}),
    code,
    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
  };
}

/**
 * The validated execution context for a code-execution approval, or `null`.
 * The wire value is untrusted `unknown`; a shape the exact guard does not
 * fully understand falls to the absent-context path (no fact rows, grants
 * suppressed) rather than rendering partially.
 */
function readRunPythonExecutionContext(
  approval: AssistantToolApprovalRequest
): CodeExecutionApprovalContext | null {
  const context: unknown = approval.executionContext;
  return isCodeExecutionApprovalContext(context) ? context : null;
}

/**
 * Whether the parent should suppress the grant buttons for this approval, or
 * `null` for tools with no preview-policy opinion (every non-code-execution
 * tool — completely unaffected). Decided in the PARENT, from the same inputs
 * the preview narrows, because the suppression has to reach the button row the
 * parent renders — a preview that returned `{ node, suppressGrants }` would be
 * easy to ignore (BST-1070 design §2.1).
 */
function resolveApprovalPreviewPolicy(
  approval: AssistantToolApprovalRequest
): { readonly suppressGrants: boolean } | null {
  if (approval.toolName !== RUN_PYTHON_TOOL_ID) {
    return null;
  }
  const suppressGrants =
    narrowRunPythonArgs(approval.args) === null || readRunPythonExecutionContext(approval) === null;
  return { suppressGrants };
}

/**
 * "Stops after 30 seconds" / "Stops after 0.4 seconds" — the shared
 * `formatRunDuration` keeps this card and the result surface agreeing, and
 * never rounds a sub-second limit into a false statement on a security card.
 */
function formatRunPythonTimeLimit(timeoutMs: number): string {
  return `Stops after ${formatRunDuration(timeoutMs)}`;
}

function RunPythonFactRow({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="w-20 shrink-0 text-muted-foreground">{label}</dt>
      <dd
        className="min-w-0 break-words text-foreground/90 [overflow-wrap:anywhere]"
        data-testid={testId}
      >
        {children}
      </dd>
    </div>
  );
}

/**
 * Fact rows for the run_python approval card. Field order is deliberate:
 * reach first (internet → write → read, most-dangerous-first), then limits.
 * EVERY row always renders — "No internet access" is an explicit row because
 * a missing row is ambiguous and an explicit negative is not (the single most
 * important copy rule on this card). Paths and domains are never truncated
 * with an ellipsis: `pypi.org.evil.com` clipped to `pypi.org…` is a lie.
 */
function RunPythonFactRows({ context }: { context: CodeExecutionApprovalContext }) {
  const domainCount = context.allowedDomains.length;
  return (
    <>
      <dl className="mt-3 space-y-1 text-xs">
        <RunPythonFactRow label="Internet" testId="approval-run-python-internet">
          {domainCount === 0 ? (
            <Badge variant="secondary">No internet access</Badge>
          ) : (
            <span>
              Wants to reach {domainCount} {domainCount === 1 ? 'domain' : 'domains'}
            </span>
          )}
        </RunPythonFactRow>
        <RunPythonFactRow label="Can write to" testId="approval-run-python-write">
          <span>A fresh private folder created for this run</span>{' '}
          <span className="font-mono">inside {context.scratchParentDir}</span>
          {context.allowWrite.map((path) => (
            <span className="block font-mono" key={path}>
              {path}
            </span>
          ))}
          <span className="block">and nowhere else.</span>
        </RunPythonFactRow>
        <RunPythonFactRow label="Can read" testId="approval-run-python-read">
          {context.defaultReadAccess === 'permissive' ? (
            // The fence's reads are PERMISSIVE by default (credential stores
            // excepted) — an empty allowRead means "most files", and claiming
            // otherwise would be a lie on a security surface.
            <span>
              Most files on this computer. Credential folders (SSH keys, cloud sign-ins) are always
              blocked.
            </span>
          ) : context.allowRead.length === 0 ? (
            <span>Nothing — it can't read your files.</span>
          ) : (
            context.allowRead.map((path) => (
              <span className="block font-mono" key={path}>
                {path}
              </span>
            ))
          )}
        </RunPythonFactRow>
        <RunPythonFactRow label="Time limit" testId="approval-run-python-time">
          {formatRunPythonTimeLimit(context.timeoutMs)}
        </RunPythonFactRow>
        <RunPythonFactRow label="Sandbox" testId="approval-run-python-sandbox">
          {context.executorKind === 'fence'
            ? 'Isolated sandbox on this machine'
            : 'Virtual machine'}
        </RunPythonFactRow>
      </dl>
      {domainCount > 0 ? (
        <p
          className="mt-2 text-amber-700 text-xs dark:text-amber-400"
          data-testid="approval-run-python-forewarning"
        >
          You'll be asked about internet access separately, right before it runs.
        </p>
      ) : null}
    </>
  );
}

/**
 * The run_python pre-run approval card (BST-1070 Gate A): the code first
 * (what will happen), then the fact rows (what it can touch). Degradations
 * are visible, never guessed: unreadable args keep the raw-JSON view with a
 * parse error, and a missing/invalid execution context renders no fact rows —
 * in both cases the parent has already suppressed the grant buttons via
 * `resolveApprovalPreviewPolicy`.
 */
function RunPythonPreview({ approval }: { approval: AssistantToolApprovalRequest }) {
  const parsed = narrowRunPythonArgs(approval.args);
  const context = readRunPythonExecutionContext(approval);
  if (!parsed) {
    return (
      <>
        <PreviewParseError />
        <p
          className="mt-1 text-amber-700 text-xs dark:text-amber-400"
          data-testid="approval-run-python-grants-suppressed-note"
        >
          Because this tool runs code, we won't offer "always allow" for a call we can't read.
        </p>
      </>
    );
  }
  const codePreview = truncatePreviewText(parsed.code);
  return (
    <div className="mt-3 text-xs">
      <p className="font-medium text-foreground/90">
        Run this Python code on your computer, in a sandbox.
      </p>
      {parsed.code.length === 0 ? (
        <p className="mt-1.5 text-muted-foreground" data-testid="approval-run-python-empty">
          This script is empty — it won't do anything.
        </p>
      ) : (
        <div className="mt-1.5 h-64 overflow-hidden rounded-md border border-border">
          <CodeSurface
            ariaLabel="Python code to run"
            language="python"
            lineWrapping
            testId="approval-run-python-code"
            truncated={codePreview.truncated}
            value={codePreview.text}
          />
        </div>
      )}
      {codePreview.truncated ? <PreviewTruncatedNote preview={codePreview} /> : null}
      {context ? <RunPythonFactRows context={context} /> : null}
      {/* Missing-context path: state the degradation AND why the grant
          buttons are gone. An EMPTY script is exempt from the alarm — it
          provably does nothing (the agent schema rejects it at execute time),
          so the empty-script line above says everything true; grants stay
          suppressed either way. */}
      {!context && parsed.code.length > 0 ? (
        <>
          <p
            className="mt-2 text-amber-700 text-xs dark:text-amber-400"
            data-testid="approval-run-python-context-missing"
          >
            We couldn't confirm what this script is allowed to touch. Check the raw arguments below
            before approving.
          </p>
          <p
            className="mt-1 text-amber-700 text-xs dark:text-amber-400"
            data-testid="approval-run-python-grants-suppressed-note"
          >
            Because this tool runs code, we won't offer "always allow" for a call we can't confirm.
          </p>
        </>
      ) : null}
    </div>
  );
}

function RootLabel({ root }: { root: string }) {
  return (
    <span
      className="inline-flex min-w-0 max-w-full rounded border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
      data-testid="approval-workspace-root"
    >
      <span className="shrink-0 whitespace-pre">{'Workspace root: '}</span>
      <span
        className="min-w-0 truncate font-mono"
        data-testid="approval-workspace-root-value"
        title={root}
      >
        {root}
      </span>
    </span>
  );
}

function FileTargetSummary({
  action,
  path,
  root,
}: {
  action?: string;
  path: string;
  root: string | undefined;
}) {
  return (
    <p
      className="flex min-w-0 flex-wrap items-center font-medium text-foreground/90 text-xs"
      data-testid="approval-file-target-summary"
    >
      {action ? <span>{action}</span> : null}
      <span className="inline-flex min-w-0 max-w-full items-center">
        {action ? <span className="shrink-0 whitespace-pre">{' · '}</span> : null}
        <span className="inline-flex min-w-0 max-w-full">
          <span className="shrink-0 whitespace-pre">{'Path: '}</span>
          <span className="min-w-0 truncate font-mono" title={path}>
            {path}
          </span>
        </span>
      </span>
      {root ? (
        <span className="inline-flex min-w-0 max-w-full items-center">
          <span className="shrink-0 whitespace-pre">{' · '}</span>
          <RootLabel root={root} />
        </span>
      ) : null}
    </p>
  );
}

function PreviewParseError() {
  return (
    <p
      className="mt-3 text-amber-700 text-xs dark:text-amber-400"
      data-testid="approval-preview-parse-error"
    >
      Could not render a preview for these arguments — see the raw arguments below.
    </p>
  );
}

function ExecuteCommandPreview({ args }: { args: unknown }) {
  const parsed = narrowExecuteCommandArgs(args);
  if (!parsed) {
    return <PreviewParseError />;
  }
  const defaultWorkingDirectory = parsed.root
    ? 'Specified workspace root (default)'
    : 'Selected workspace root (default)';

  return (
    <div className="mt-3">
      <p className="font-medium text-foreground/90 text-xs">Command</p>
      <pre
        className="mt-1.5 max-w-full select-text overflow-x-hidden whitespace-pre-wrap rounded-md border border-border bg-muted/60 p-3 font-mono text-xs leading-5 [overflow-wrap:anywhere]"
        data-testid="approval-command-preview"
      >
        <code data-testid="approval-command-code">{parsed.command}</code>
      </pre>
      <dl className="mt-2 space-y-1 text-xs">
        <div className="flex min-w-0 gap-2">
          <dt className="shrink-0 text-muted-foreground">Working directory</dt>
          <dd
            className="min-w-0 break-words font-mono text-foreground/90 [overflow-wrap:anywhere]"
            data-testid="approval-command-cwd"
          >
            {parsed.cwd ?? defaultWorkingDirectory}
          </dd>
        </div>
        {parsed.root ? (
          <div className="flex min-w-0 gap-2">
            <dt className="shrink-0 text-muted-foreground">Workspace</dt>
            <dd
              className="min-w-0 break-words font-mono text-foreground/90 [overflow-wrap:anywhere]"
              data-testid="approval-command-root"
            >
              {parsed.root}
            </dd>
          </div>
        ) : null}
        {parsed.timeoutMs === undefined ? null : (
          <div className="flex min-w-0 gap-2">
            <dt className="shrink-0 text-muted-foreground">Timeout</dt>
            <dd className="font-mono text-foreground/90" data-testid="approval-command-timeout">
              {parsed.timeoutMs} ms
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}

function RunSkillScriptPreview({ args }: { args: unknown }) {
  const parsed = narrowRunSkillScriptArgs(args);
  if (!parsed) {
    return <PreviewParseError />;
  }
  const fileName = parsed.scriptPath.split('/').at(-1) ?? parsed.scriptPath;
  return (
    <div className="mt-3 text-xs" data-testid="approval-skill-script-summary">
      <p className="font-medium text-foreground/90">
        Run script <span className="font-mono">{fileName}</span> from activated skill{' '}
        <span className="font-mono">{parsed.skillName}</span>
      </p>
      <dl className="mt-2 space-y-1">
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Skill path</dt>
          <dd className="font-mono" data-testid="approval-skill-script-path">
            {parsed.scriptPath}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Mounted root</dt>
          <dd className="font-mono" data-testid="approval-skill-script-root">
            {parsed.root}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Working directory</dt>
          <dd className="font-mono" data-testid="approval-skill-script-cwd">
            {parsed.cwd}
          </dd>
        </div>
        {parsed.args?.length ? (
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Arguments</dt>
            <dd className="font-mono" data-testid="approval-skill-script-args">
              {parsed.args.join(' ')}
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

interface TruncatedPreviewText {
  readonly shownChars: number;
  readonly text: string;
  readonly totalChars: number;
  readonly truncated: boolean;
}

/**
 * Slices `raw` to at most `cap` chars, never splitting a UTF-16 surrogate
 * pair at the boundary (mirrors the DOM-paint cap in
 * `file-tab-body.tsx`'s `getDisplayContent`). Returns the shown/total
 * char counts so callers can render an honest "N of M" truncation note.
 */
function truncatePreviewText(
  raw: string,
  cap: number = APPROVAL_PREVIEW_CHAR_CAP
): TruncatedPreviewText {
  if (raw.length <= cap) {
    return { shownChars: raw.length, text: raw, totalChars: raw.length, truncated: false };
  }
  let end = cap;
  const HighSurrogateStart = 0xd8_00;
  const HighSurrogateEnd = 0xdb_ff;
  if (
    end > 0 &&
    raw.charCodeAt(end - 1) >= HighSurrogateStart &&
    raw.charCodeAt(end - 1) <= HighSurrogateEnd
  ) {
    end -= 1;
  }
  return { shownChars: end, text: raw.slice(0, end), totalChars: raw.length, truncated: true };
}

/** Of two candidate truncations, the one whose original text is larger drives the note. */
function moreTruncatedPreview(
  a: TruncatedPreviewText,
  b: TruncatedPreviewText
): TruncatedPreviewText {
  return a.totalChars >= b.totalChars ? a : b;
}

function PreviewTruncatedNote({ preview }: { preview: TruncatedPreviewText }) {
  return (
    <p
      className="mt-1.5 text-amber-700 text-xs dark:text-amber-400"
      data-testid="approval-preview-truncated-note"
    >
      Preview truncated — showing {preview.shownChars} of {preview.totalChars} chars. Full content
      is in the raw arguments below.
    </p>
  );
}

/**
 * Mutating approvals render a structured preview: `executeCommand` → the exact
 * command and execution context; `stringReplace` → a side-by-side/unified diff
 * of `oldStr` → `newStr`; `write` → a syntax-highlighted full-file preview.
 * Every other tool renders `null`. Known preview tools whose args fail strict
 * narrowing show a visible parse error and keep the raw-JSON view.
 */
function ApprovalPreview({ approval }: { approval: AssistantToolApprovalRequest }) {
  const { args, toolName } = approval;
  if (toolName === EXECUTE_COMMAND_TOOL_ID) {
    return <ExecuteCommandPreview args={args} />;
  }
  if (toolName === RUN_PYTHON_TOOL_ID) {
    // Needs the whole approval, not just args: the fact rows come from the
    // server-computed executionContext (§2.2), which args cannot carry.
    return <RunPythonPreview approval={approval} />;
  }
  if (toolName === RUN_SKILL_SCRIPT_TOOL_ID) {
    return <RunSkillScriptPreview args={args} />;
  }

  if (toolName === STRING_REPLACE_TOOL_ID) {
    const parsed = narrowStringReplaceArgs(args);
    if (!parsed) {
      return <PreviewParseError />;
    }
    const oldPreview = truncatePreviewText(parsed.oldStr);
    const newPreview = truncatePreviewText(parsed.newStr);
    const isTruncated = oldPreview.truncated || newPreview.truncated;
    return (
      <div className="mt-3">
        <FileTargetSummary path={parsed.path} root={parsed.root} />
        <div className="mt-1.5 h-72 overflow-hidden rounded-md border border-border">
          <DiffView
            ariaLabel={`Proposed changes to ${parsed.path}`}
            filename={parsed.path}
            modified={newPreview.text}
            original={oldPreview.text}
            testId="approval-diff-view"
            truncated={isTruncated}
          />
        </div>
        {isTruncated ? (
          <PreviewTruncatedNote preview={moreTruncatedPreview(oldPreview, newPreview)} />
        ) : null}
      </div>
    );
  }

  if (toolName === WRITE_FILE_TOOL_ID) {
    const parsed = narrowWriteFileArgs(args);
    if (!parsed) {
      return <PreviewParseError />;
    }
    const contentPreview = truncatePreviewText(parsed.content);
    return (
      <div className="mt-3">
        <FileTargetSummary action="Creates or overwrites" path={parsed.path} root={parsed.root} />
        <div className="mt-1.5 h-64 overflow-hidden rounded-md border border-border">
          <CodeSurface
            ariaLabel={`New content for ${parsed.path}`}
            path={parsed.path}
            testId="approval-write-preview"
            truncated={contentPreview.truncated}
            value={contentPreview.text}
          />
        </div>
        {contentPreview.truncated ? <PreviewTruncatedNote preview={contentPreview} /> : null}
      </div>
    );
  }

  return null;
}

function isAssistantToolApprovalRequest(value: unknown): value is AssistantToolApprovalRequest {
  return (
    isRecord(value) &&
    typeof value['runId'] === 'string' &&
    typeof value['toolCallId'] === 'string' &&
    typeof value['toolName'] === 'string' &&
    (!('delegation' in value) ||
      (Object.hasOwn(value, 'delegation') && isDelegatedToolActionIdentity(value['delegation'])))
  );
}

/**
 * Human-readable reason for the approval, derived from the permission risk
 * bucket that resolved to `'ask'`. Returns `null` when the pause carried no
 * risk hint (e.g. a non-policy approval), so the notice omits the reason rather
 * than inventing one.
 */
const RISK_CATEGORY_REASON: Record<string, string> = {
  edit: 'edit (modifies files or state)',
  // "commands or code": run_python is execute-risk and runs code, not a
  // command — and the wider phrasing reads better for executeCommand too.
  execute: 'execute (runs commands or code on your computer)',
  mcp: 'external MCP tool',
  read: 'read',
};

function resolveApprovalReason(approval: AssistantToolApprovalRequest): string | null {
  const risk = approval.riskCategory;
  if (typeof risk !== 'string') {
    return null;
  }
  return RISK_CATEGORY_REASON[risk] ?? risk;
}

/**
 * User-facing plural nouns for the session-grant button ("Allow commands this
 * session"). Distinct from RISK_CATEGORY_REASON, which explains WHY this call
 * paused.
 */
const RISK_CATEGORY_GRANT_NOUN: Record<ToolRiskCategory, string> = {
  edit: 'edits',
  execute: 'commands',
  mcp: 'MCP tools',
  read: 'reads',
};

/**
 * The grant risk category for this approval, or `null` when the pause carried
 * no valid risk hint (a non-policy approval) — grants only make sense for
 * policy-driven asks, so the buttons are omitted rather than over-promising.
 */
function resolveGrantCategory(approval: AssistantToolApprovalRequest): ToolRiskCategory | null {
  return isToolRiskCategory(approval.riskCategory) ? approval.riskCategory : null;
}

function formatJsonValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

type ApprovalRunOutcomeState = 'none' | 'pending' | 'retryable' | 'completed';

interface ApprovalRunOutcome {
  action: AssistantToolApprovalDecision | null;
  state: ApprovalRunOutcomeState;
}

const emptyApprovalRunOutcome: ApprovalRunOutcome = { action: null, state: 'none' };
const APPROVAL_RUN_OUTCOME_SEPARATOR = ':';

type ApprovalRunOutcomeKey =
  `${AssistantToolApprovalDecision | 'none'}${typeof APPROVAL_RUN_OUTCOME_SEPARATOR}${ApprovalRunOutcomeState}`;

function toApprovalRunOutcomeKey(outcome: ApprovalRunOutcome): ApprovalRunOutcomeKey {
  return `${outcome.action ?? 'none'}${APPROVAL_RUN_OUTCOME_SEPARATOR}${outcome.state}`;
}

function fromApprovalRunOutcomeKey(key: ApprovalRunOutcomeKey): ApprovalRunOutcome {
  const [action, state] = key.split(APPROVAL_RUN_OUTCOME_SEPARATOR) as [
    AssistantToolApprovalDecision | 'none',
    ApprovalRunOutcomeState,
  ];
  return { action: action === 'none' ? null : action, state };
}

function isMatchingApprovalAction(value: unknown, approval: AssistantToolApprovalRequest): boolean {
  return isMatchingToolAction(value, approval);
}

function getMessageRole(message: unknown): unknown {
  return isRecord(message) ? message['role'] : undefined;
}

function getMessageStatus(message: unknown): Record<string, unknown> | undefined {
  if (!isRecord(message)) {
    return;
  }
  const status = message['status'];
  return isRecord(status) ? status : undefined;
}

function getToolApprovalActionFromMessage(message: unknown): unknown {
  if (!isRecord(message)) {
    return;
  }
  const metadata = message['metadata'];
  if (!isRecord(metadata)) {
    return;
  }
  const custom = metadata['custom'];
  if (!isRecord(custom)) {
    return;
  }
  return custom[TOOL_APPROVAL_RUN_CONFIG_KEY];
}

function getToolApprovalDecision(value: unknown): AssistantToolApprovalDecision | null {
  if (!isRecord(value)) {
    return null;
  }
  const action = value['action'];
  return action === 'approve' || action === 'decline' ? action : null;
}

function resolveApprovalRunOutcome(
  messages: readonly unknown[],
  approval: AssistantToolApprovalRequest | null
): ApprovalRunOutcome {
  if (!approval) {
    return emptyApprovalRunOutcome;
  }

  let submittedMessageIndex = -1;
  let submittedAction: AssistantToolApprovalDecision | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const approvalAction = getToolApprovalActionFromMessage(message);
    if (getMessageRole(message) === 'user' && isMatchingApprovalAction(approvalAction, approval)) {
      submittedMessageIndex = index;
      submittedAction = getToolApprovalDecision(approvalAction);
      break;
    }
  }
  if (submittedMessageIndex < 0) {
    return emptyApprovalRunOutcome;
  }

  for (let index = submittedMessageIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    const role = getMessageRole(message);
    if (role === 'user') {
      return { action: submittedAction, state: 'pending' };
    }
    if (role !== 'assistant') {
      continue;
    }

    const status = getMessageStatus(message);
    if (status?.['type'] === 'complete') {
      return { action: submittedAction, state: 'completed' };
    }
    if (status?.['type'] === 'incomplete') {
      return { action: submittedAction, state: 'retryable' };
    }
    return { action: submittedAction, state: 'pending' };
  }

  return { action: submittedAction, state: 'pending' };
}

/**
 * The two GRANT actions offered alongside Approve/Decline: "Always allow this
 * tool" (persisted per-tool override) and "Allow <category> this session"
 * (session grant, cleared on reload). Rendered only when a
 * `ToolApprovalGrantProvider` is mounted (app-shell; no provider → null,
 * capability gating) AND the approval is policy-driven (`grantCategory`
 * present) — a non-policy pause must not over-promise a grant.
 *
 * Each button records the grant FIRST, then approves the pending call through
 * the normal resume. Ordering is deliberate: if the approve append fails, the
 * grant has still been recorded, so the retried/next run is already allowed —
 * the safe, least-surprising direction for a button that says "always/this
 * session".
 */
function ApprovalGrantButtons({
  approve,
  disabled,
  grantCategory,
  toolName,
}: {
  approve: () => void;
  disabled: boolean;
  grantCategory: ToolRiskCategory | null;
  toolName: string;
}) {
  const grants = useToolApprovalGrants();
  if (!(grants && grantCategory)) {
    return null;
  }
  const grantNoun = RISK_CATEGORY_GRANT_NOUN[grantCategory];
  return (
    <>
      <Button
        aria-label={`Always allow ${toolName}`}
        data-testid="approval-grant-tool-always"
        disabled={disabled}
        onClick={() => {
          grants.grantToolAlways(toolName);
          approve();
        }}
        size="sm"
        title={`Approve and always allow ${toolName} (persists until removed in Settings > Permissions)`}
        variant="outline"
      >
        <ShieldCheck className="size-3.5" />
        Always allow
      </Button>
      <Button
        aria-label={`Allow ${grantNoun} for this session`}
        data-testid="approval-grant-category-session"
        disabled={disabled}
        onClick={() => {
          grants.grantCategoryForSession(grantCategory);
          approve();
        }}
        size="sm"
        title={`Approve and allow all ${grantNoun} until the app reloads`}
        variant="outline"
      >
        <Timer className="size-3.5" />
        Allow {grantNoun} this session
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="More grant options"
            data-testid="approval-grant-overflow"
            disabled={disabled}
            size="sm"
            title="More grant options"
            variant="outline"
          >
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem
            data-testid="approval-grant-all-session"
            onSelect={() => {
              // Grant FIRST, then approve — same ordering contract as the
              // inline grant buttons (if the approve append fails, the grant is
              // already recorded for the retried/next run).
              grants.grantAllToolsForSession();
              approve();
            }}
          >
            <ShieldCheck className="size-3.5" />
            Allow all tools this session
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

/** Status chip text for the notice header. */
function resolveApprovalStatusLabel(
  displayedAction: AssistantToolApprovalDecision | null,
  actionLockedByRun: boolean
): string {
  if (displayedAction === 'approve') {
    return 'Approved';
  }
  if (displayedAction === 'decline') {
    return 'Declined';
  }
  return actionLockedByRun ? 'Submitted' : 'Pending';
}

export function AssistantToolApprovalNotice({ data }: AssistantToolApprovalNoticeProps) {
  const key = isAssistantToolApprovalRequest(data) ? getToolActionIdentityKey(data) : 'invalid';
  return <ToolApprovalNotice data={data} key={key} />;
}

function ToolApprovalNotice({ data }: AssistantToolApprovalNoticeProps) {
  const aui = useAui();
  const [isExpanded, setIsExpanded] = useState(false);
  const [submittedAction, setSubmittedAction] = useState<AssistantToolApprovalDecision | null>(
    null
  );
  const detailsId = useId();
  const approval = isAssistantToolApprovalRequest(data) ? data : null;
  const approvalReason = approval ? resolveApprovalReason(approval) : null;
  // BST-1070: a code-execution approval whose args fail strict narrowing or
  // whose execution context is absent/invalid keeps Approve/Decline (the raw
  // JSON is right there) but suppresses the GRANT buttons — no "always allow"
  // for a call we can't read. Suppression reuses the existing null-category
  // capability-gating path in ApprovalGrantButtons rather than adding a
  // second one. Every other tool's previewPolicy is null and unaffected.
  const previewPolicy = approval ? resolveApprovalPreviewPolicy(approval) : null;
  const grantCategory =
    approval && !previewPolicy?.suppressGrants ? resolveGrantCategory(approval) : null;
  const rediscovered = approval ? readRediscoveredPauseDisplay(data) : null;
  const approvalRunOutcomeKey = useAuiState((state) =>
    toApprovalRunOutcomeKey(resolveApprovalRunOutcome(state.thread.messages, approval))
  );
  const approvalRunOutcome = useMemo(
    () => fromApprovalRunOutcomeKey(approvalRunOutcomeKey),
    [approvalRunOutcomeKey]
  );
  const actionLockedByRun =
    approvalRunOutcome.state === 'pending' || approvalRunOutcome.state === 'completed';
  const detailEntries = useMemo(() => {
    if (!approval) {
      return [];
    }
    return [
      ['runId', approval.runId],
      ['toolCallId', approval.toolCallId],
      ['args', approval.args],
      ['resumeSchema', approval.resumeSchema],
    ].filter((entry): entry is [string, unknown] => entry[1] !== undefined);
  }, [approval]);
  const submitApprovalAction = useCallback(
    (action: AssistantToolApprovalDecision): void => {
      if (!(approval && submittedAction === null && !actionLockedByRun)) {
        return;
      }

      const approvalAction: AssistantToolApprovalAction = {
        action,
        ...getToolActionTarget(approval),
        toolName: approval.toolName,
      };
      const verb = action === 'approve' ? 'Approved' : 'Declined';
      const message = {
        content: [{ text: `${verb} ${approval.toolName}.`, type: 'text' }],
        metadata: {
          custom: {
            [TOOL_APPROVAL_RUN_CONFIG_KEY]: approvalAction,
          },
        },
        role: 'user',
        runConfig: {
          custom: {
            [TOOL_APPROVAL_RUN_CONFIG_KEY]: approvalAction,
          },
        },
        startRun: true,
      } satisfies CreateAppendMessage;

      setSubmittedAction(action);
      try {
        void Promise.resolve(aui.thread().append(message)).catch((error: unknown) => {
          setSubmittedAction(null);
          logger.warn('Failed to append tool approval action', {
            error,
            runId: approval.runId,
            toolCallId: approval.toolCallId,
          });
        });
      } catch (error) {
        setSubmittedAction(null);
        logger.warn('Failed to append tool approval action', {
          error,
          runId: approval.runId,
          toolCallId: approval.toolCallId,
        });
      }
    },
    [actionLockedByRun, approval, aui, submittedAction]
  );

  useEffect(() => {
    if (submittedAction === null || approvalRunOutcome.state !== 'retryable') {
      return;
    }
    setSubmittedAction(null);
  }, [approvalRunOutcome.state, submittedAction]);

  if (!approval) {
    return null;
  }

  const displayedAction = submittedAction ?? (actionLockedByRun ? approvalRunOutcome.action : null);
  const approvalStatus = resolveApprovalStatusLabel(displayedAction, actionLockedByRun);
  const actionButtonsDisabled = submittedAction !== null || actionLockedByRun;

  return (
    <div
      className="my-2 rounded-lg border border-amber-500/40 bg-amber-50/50 dark:bg-amber-950/20"
      data-testid="assistant-tool-approval-notice"
    >
      <div className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] gap-3 px-4 py-3">
        <div aria-hidden="true" className="pt-0.5">
          <AlertTriangle className="size-4 text-amber-700 dark:text-amber-400" />
        </div>
        <div className="min-w-0">
          <p className="font-medium text-sm">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <span className="truncate">Tool approval required</span>
            </span>
            <span className="ml-2 rounded-full border border-amber-500/40 bg-amber-100/70 px-2 py-0.5 text-[10px] text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
              {approvalStatus}
            </span>
          </p>
          <p className="mt-1 truncate text-muted-foreground text-xs">{approval.toolName}</p>
          {approvalReason ? (
            <p className="mt-0.5 truncate text-amber-700 text-xs dark:text-amber-400">
              Requires approval: {approvalReason}
            </p>
          ) : null}
          <RediscoveredPauseLines display={rediscovered} />
          <ApprovalPreview approval={approval} />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              aria-label={`Approve ${approval.toolName}`}
              disabled={actionButtonsDisabled}
              onClick={() => submitApprovalAction('approve')}
              size="sm"
              title={`Approve ${approval.toolName}`}
              variant="default"
            >
              <Check className="size-3.5" />
              Approve
            </Button>
            <Button
              aria-label={`Decline ${approval.toolName}`}
              disabled={actionButtonsDisabled}
              onClick={() => submitApprovalAction('decline')}
              size="sm"
              title={`Decline ${approval.toolName}`}
              variant="outline"
            >
              <X className="size-3.5" />
              Decline
            </Button>
            <ApprovalGrantButtons
              approve={() => submitApprovalAction('approve')}
              disabled={actionButtonsDisabled}
              grantCategory={grantCategory}
              toolName={approval.toolName}
            />
          </div>
        </div>
        <Button
          aria-controls={isExpanded ? detailsId : undefined}
          aria-expanded={isExpanded}
          aria-label={
            isExpanded ? 'Collapse tool approval details' : 'Expand tool approval details'
          }
          className="size-8"
          onClick={() => setIsExpanded((current) => !current)}
          size="icon"
          title={isExpanded ? 'Collapse tool approval details' : 'Expand tool approval details'}
          variant="ghost"
        >
          {isExpanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </Button>
      </div>
      {isExpanded ? (
        <div className="border-amber-500/30 border-t border-dashed px-4 py-3" id={detailsId}>
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
            {detailEntries.map(([key, value]) => (
              <div className="contents" key={key}>
                <dt className="font-medium text-muted-foreground">{key}</dt>
                <dd className="min-w-0 break-words text-foreground/90">
                  <pre className="whitespace-pre-wrap font-mono text-[11px] leading-4">
                    {formatJsonValue(value)}
                  </pre>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}

AssistantToolApprovalNotice.displayName = 'AssistantToolApprovalNotice';
