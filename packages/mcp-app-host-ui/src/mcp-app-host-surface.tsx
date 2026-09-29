import type { McpAppToolCallAuthority } from '@brainstrike/mcp-app-host';
import { Button } from '@brainstrike/ui';
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

export type McpAppHostErrorCode = 'load-failed' | 'permission-failed' | 'protocol-failed';

export type McpAppHostState =
  | Readonly<{ phase: 'cancelled' | 'completed' | 'loading' | 'ready' }>
  | Readonly<{ code: McpAppHostErrorCode; phase: 'error' }>;

export interface McpAppHostSurfaceProps {
  readonly appName: string;
  readonly authority: McpAppToolCallAuthority;
  readonly children?: ReactNode;
  readonly onCancel?: () => void;
  readonly onRetry?: () => void;
  readonly recoveryFocusRef: RefObject<HTMLElement | null>;
  readonly state: McpAppHostState;
}

const ERROR_MESSAGES: Readonly<Record<McpAppHostErrorCode, string>> = Object.freeze({
  'load-failed': 'The app resource could not be loaded safely.',
  'permission-failed': 'The app permission request could not be completed safely.',
  'protocol-failed': 'The app could not start safely.',
});

function focus(element: HTMLElement | null): void {
  element?.focus();
}

function LoadingState({ appName, onCancel }: Pick<McpAppHostSurfaceProps, 'appName' | 'onCancel'>) {
  return (
    <section aria-label={appName} className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <span aria-live="polite" role="status">
          Loading {appName}…
        </span>
        {onCancel ? (
          <Button aria-label={`Cancel ${appName}`} onClick={onCancel} size="sm" variant="outline">
            Cancel
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function ErrorState({
  appName,
  code,
  onRetry,
}: Pick<McpAppHostSurfaceProps, 'appName' | 'onRetry'> & { readonly code: McpAppHostErrorCode }) {
  const focusAlert = useCallback(
    (node: HTMLDivElement | null): void => {
      if (node && !onRetry) {
        node.focus();
      }
    },
    [onRetry]
  );
  const focusRetry = useCallback((node: HTMLButtonElement | null): void => node?.focus(), []);
  return (
    <section aria-label={appName} className="rounded-lg border border-destructive/40 bg-card p-4">
      <div className="flex flex-col items-start gap-3" ref={focusAlert} role="alert" tabIndex={-1}>
        <p>{ERROR_MESSAGES[code]}</p>
        {onRetry ? (
          <Button
            aria-label={`Retry ${appName}`}
            onClick={onRetry}
            ref={focusRetry}
            size="sm"
            variant="outline"
          >
            Retry
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function TerminalState({
  appName,
  phase,
  recoveryFocusRef,
}: Pick<McpAppHostSurfaceProps, 'appName' | 'recoveryFocusRef'> & {
  readonly phase: 'cancelled' | 'completed';
}) {
  const recover = useCallback(
    (node: HTMLElement | null): void => {
      if (node) {
        focus(recoveryFocusRef.current);
      }
    },
    [recoveryFocusRef]
  );
  return (
    <section
      aria-label={appName}
      aria-live="polite"
      className="rounded-lg border border-border bg-card p-4 text-muted-foreground text-sm"
      ref={recover}
      role="status"
    >
      {appName} {phase === 'cancelled' ? 'was cancelled.' : 'completed.'}
    </section>
  );
}

export function McpAppHostSurface({
  appName,
  authority,
  children,
  onCancel,
  onRetry,
  recoveryFocusRef,
  state,
}: McpAppHostSurfaceProps) {
  const subscribe = useCallback(
    (listener: () => void) => {
      let previousApprovalId = authority.snapshot.pendingApprovals[0]?.id;
      return authority.subscribe(() => {
        const nextApprovalId = authority.snapshot.pendingApprovals[0]?.id;
        listener();
        if (previousApprovalId !== undefined && nextApprovalId === undefined) {
          queueMicrotask(() => focus(recoveryFocusRef.current));
        }
        previousApprovalId = nextApprovalId;
      });
    },
    [authority, recoveryFocusRef]
  );
  const getSnapshot = useCallback(() => authority.snapshot, [authority]);
  const authoritySnapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const approval = authoritySnapshot.pendingApprovals[0];
  // Focus "Allow once" only when a different approval takes over, never on
  // the unrelated re-renders every authority publish causes: yanking focus
  // from Deny to Allow mid-decision would be a consent-integrity bug. The
  // callback is stable; it compares the button's approval id itself.
  const focusedApprovalRef = useRef<string | undefined>(undefined);
  const focusApproval = useCallback((node: HTMLButtonElement | null): void => {
    const nodeApprovalId = node?.dataset['approvalId'];
    if (node === null || nodeApprovalId === focusedApprovalRef.current) {
      return;
    }
    focusedApprovalRef.current = nodeApprovalId;
    node.focus();
  }, []);
  const [actionErrorId, setActionErrorId] = useState<string | undefined>(undefined);

  const approve = (): void => {
    if (!(approval && authority.approve(approval.id))) {
      setActionErrorId(approval?.id);
    }
  };
  const deny = (): void => {
    if (!(approval && authority.deny(approval.id))) {
      setActionErrorId(approval?.id);
    }
  };
  const handleConsentKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      deny();
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const buttons = event.currentTarget.parentElement?.querySelectorAll('button');
    const first = buttons?.item(0);
    const last = buttons?.item(1);
    if (!(first && last)) {
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (state.phase === 'loading') {
    return <LoadingState appName={appName} {...(onCancel ? { onCancel } : {})} />;
  }

  if (state.phase === 'error') {
    return <ErrorState appName={appName} code={state.code} {...(onRetry ? { onRetry } : {})} />;
  }

  if (state.phase === 'cancelled' || state.phase === 'completed') {
    return (
      <TerminalState appName={appName} phase={state.phase} recoveryFocusRef={recoveryFocusRef} />
    );
  }

  if (authoritySnapshot.phase === 'closed') {
    return (
      <section aria-label={appName} className="rounded-lg border border-destructive/40 bg-card p-4">
        <p role="alert">The app session is closed.</p>
      </section>
    );
  }

  return (
    <section aria-label={appName} className="relative rounded-lg border border-border bg-card">
      <div aria-hidden={approval ? true : undefined} inert={approval ? true : undefined}>
        <div className="min-h-24">{children}</div>
        {onCancel ? (
          <Button
            aria-label={`Cancel ${appName}`}
            className="absolute top-2 right-2"
            onClick={onCancel}
            size="sm"
            variant="outline"
          >
            Cancel
          </Button>
        ) : null}
      </div>
      {approval ? (
        <div
          aria-label={`Allow ${appName} to use ${approval.toolName}?`}
          aria-modal="true"
          className="absolute inset-0 flex items-center justify-center bg-background/90 p-4"
          role="alertdialog"
        >
          <div className="flex max-w-sm flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-lg">
            <p className="font-medium">Allow {approval.toolName}?</p>
            <p className="text-muted-foreground text-sm">
              This {approval.riskCategory} action requires your approval.
            </p>
            {authoritySnapshot.pendingApprovals.length > 1 ? (
              <p className="text-muted-foreground text-xs">
                {authoritySnapshot.pendingApprovals.length - 1} more request
                {authoritySnapshot.pendingApprovals.length === 2 ? '' : 's'} waiting.
              </p>
            ) : null}
            {actionErrorId === approval.id ? (
              <p className="text-destructive text-sm" role="alert">
                This request is no longer pending. Return to the app and try again.
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                aria-label={`Deny ${approval.toolName}`}
                onClick={deny}
                onKeyDown={handleConsentKeyDown}
                variant="outline"
              >
                Deny
              </Button>
              <Button
                aria-label={`Allow ${approval.toolName} once`}
                data-approval-id={approval.id}
                onClick={approve}
                onKeyDown={handleConsentKeyDown}
                ref={focusApproval}
              >
                Allow once
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
