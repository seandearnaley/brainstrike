import { type CreateAppendMessage, useAui, useAuiState } from '@assistant-ui/react';
import type {
  AssistantToolApprovalAction,
  AssistantToolApprovalDecision,
  AssistantToolApprovalRequest,
} from '@brainstrike/assistant-contract/tool-approval';
import { TOOL_APPROVAL_RUN_CONFIG_KEY } from '@brainstrike/assistant-contract/tool-approval';
import {
  isToolRiskCategory,
  type ToolRiskCategory,
} from '@brainstrike/assistant-contract/tool-metadata';
import { createLogger } from '@brainstrike/utils/logger';
import { AlertTriangle, Check, ChevronDown, ChevronUp, ShieldCheck, Timer, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Button } from '../button';
import { CodeSurface } from '../code-surface/code-surface';
import { DiffView } from '../diff-view/diff-view';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../dropdown-menu';
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
 * Registered ids of the two file-mutating tools whose approval cards render a
 * real code preview instead of raw JSON. These are the sanitized-name-resolved
 * ids the approval chunk carries (see `makeApprovalRequiredChunks` in the agent
 * runtime), NOT the model-facing names.
 */
const STRING_REPLACE_TOOL_ID = 'brainstrike.stringReplaceWorkspaceFile';
const WRITE_FILE_TOOL_ID = 'brainstrike.writeWorkspaceFile';

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

function RootLabel({ root }: { root: string }) {
  return (
    <span className="ml-2 rounded border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      {root}
    </span>
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

interface TruncatedPreviewText {
  readonly shownChars: number;
  readonly text: string;
  readonly totalChars: number;
  readonly truncated: boolean;
}

/**
 * Slices `raw` to at most `cap` chars, never splitting a UTF-16 surrogate
 * pair at the boundary (mirrors the DOM-paint cap in
 * `workspace-tab-host.tsx`'s `getDisplayContent`). Returns the shown/total
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
 * File-mutating approvals render a real code preview: `stringReplace` → a
 * side-by-side/unified diff of `oldStr` → `newStr`; `write` → a
 * syntax-highlighted full-file preview. Every other tool (and any file-tool
 * whose args fail narrowing) renders `null` here and keeps the raw-JSON view.
 */
function ApprovalPreview({ toolName, args }: { toolName: string; args: unknown }) {
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
        <p className="truncate font-medium text-foreground/90 text-xs">
          <span className="font-mono">{parsed.path}</span>
          {parsed.root ? <RootLabel root={parsed.root} /> : null}
        </p>
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
        <p className="truncate font-medium text-foreground/90 text-xs">
          Creates or overwrites <span className="font-mono">{parsed.path}</span>
          {parsed.root ? <RootLabel root={parsed.root} /> : null}
        </p>
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
    typeof value['toolName'] === 'string'
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
  execute: 'execute (runs a command)',
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

/**
 * Rediscovery metadata carried ONLY by an approval re-surfaced from workflow
 * storage after a restart/reload (see RediscoveredToolApproval). A live-stream
 * approval has neither field, so the extra lines are absent on the live path.
 */
interface RediscoveredApprovalDisplay {
  readonly stale: boolean;
  readonly suspendedAt: string;
}

function readRediscoveredDisplay(data: unknown): RediscoveredApprovalDisplay | null {
  if (!isRecord(data)) {
    return null;
  }
  const suspendedAt = data['suspendedAt'];
  const stale = data['stale'];
  if (typeof suspendedAt !== 'string' || typeof stale !== 'boolean') {
    return null;
  }
  return { stale, suspendedAt };
}

const RELATIVE_TIME_UNITS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

// Building an Intl formatter is expensive; hoist a single shared instance.
const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "Pending since <relative>" text; null when the timestamp is unparseable. */
function formatPendingSince(suspendedAt: string, now: number): string | null {
  const suspendedMs = Date.parse(suspendedAt);
  if (Number.isNaN(suspendedMs)) {
    return null;
  }
  const elapsedMs = Math.max(0, now - suspendedMs);
  for (const [unit, unitMs] of RELATIVE_TIME_UNITS) {
    if (elapsedMs >= unitMs) {
      return RELATIVE_TIME_FORMATTER.format(-Math.floor(elapsedMs / unitMs), unit);
    }
  }
  return RELATIVE_TIME_FORMATTER.format(-Math.floor(elapsedMs / 1000), 'second');
}

/**
 * The two additive lines a REDISCOVERED approval renders (a live approval passes
 * `display === null` and renders nothing extra). Display-only per D5 — it never
 * disables the Approve/Decline buttons.
 */
function RediscoveredApprovalLines({ display }: { display: RediscoveredApprovalDisplay | null }) {
  // Freeze the reference clock at mount (lazy initializer runs once) so render
  // stays pure — "pending since" is a mount-anchored relative time, it does not
  // need to tick, and this keeps React Compiler able to memoize the component.
  const [renderedAt] = useState(() => Date.now());
  if (!display) {
    return null;
  }
  const pendingSince = formatPendingSince(display.suspendedAt, renderedAt);
  return (
    <>
      {pendingSince ? (
        <p className="mt-0.5 truncate text-muted-foreground text-xs">
          Pending since {pendingSince}
        </p>
      ) : null}
      {display.stale ? (
        <p className="mt-0.5 text-amber-700 text-xs dark:text-amber-400">
          This approval has been pending a while — re-running the request may be safer.
        </p>
      ) : null}
    </>
  );
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
  return (
    isRecord(value) &&
    value['runId'] === approval.runId &&
    value['toolCallId'] === approval.toolCallId
  );
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
  const aui = useAui();
  const [isExpanded, setIsExpanded] = useState(false);
  const [submittedAction, setSubmittedAction] = useState<AssistantToolApprovalDecision | null>(
    null
  );
  const detailsId = useId();
  const approval = isAssistantToolApprovalRequest(data) ? data : null;
  const approvalReason = approval ? resolveApprovalReason(approval) : null;
  const grantCategory = approval ? resolveGrantCategory(approval) : null;
  const rediscovered = approval ? readRediscoveredDisplay(data) : null;
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
        runId: approval.runId,
        toolCallId: approval.toolCallId,
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
          <RediscoveredApprovalLines display={rediscovered} />
          <ApprovalPreview args={approval.args} toolName={approval.toolName} />
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
