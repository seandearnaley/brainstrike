import { Button } from '@brainstrike/ui';
import { Bot, RotateCw, TerminalSquare } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import type { TerminalTarget } from '../stores/terminal-target-store';
import { useTerminalTargetStore } from '../stores/terminal-target-store';
import { useCommandSessionBridge } from '../workspace-terminal-services';
import { CommandSessionInventory } from './command-session-inventory';
import { useActiveRootId } from './use-active-root-id';
import { useTerminalSession } from './use-terminal-session';

/**
 * Desktop terminal surface. Runs a REAL interactive shell in the focused
 * workspace root via the provided terminal pty bridge, rendered with xterm.js.
 *
 * All bridge interaction + the imperative xterm lifecycle live in
 * {@link useTerminalSession}; this component resolves the active root, mounts the
 * xterm host element, and renders the discriminated session state (starting /
 * ready / exited-with-restart / error). Every failure is a visible state + toast
 * inside the hook — never a blank panel.
 *
 * Constructed only when a terminal bridge is provided; it still
 * renders its own no-root empty state. On a root focus-change the existing
 * session keeps running (it is pinned to its cwd); switching the active root
 * starts a fresh session for the newly focused root. A `terminal-target-store`
 * pin (BST-1457 "Open in Terminal") OVERRIDES the focused root and adds an
 * explicit "Follow focused folder" release, so a pin is visible and reversible
 * rather than a state the user cannot leave.
 */
interface HumanTerminalProps {
  /** Pinned checkout path, or null when following the focused root. */
  readonly cwd: string | null;
  /** Present ONLY while a target is pinned — its absence IS "we follow focus". */
  readonly onClearTarget: (() => void) | undefined;
  readonly rootId: string;
}

function HumanTerminal({ cwd, onClearTarget, rootId }: HumanTerminalProps): ReactElement {
  const { containerRef, restart, state } = useTerminalSession(rootId, cwd);

  const isExited = state.kind === 'exited';
  const isError = state.kind === 'error';

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <div className="border-border flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <TerminalSquare aria-hidden="true" className="text-muted-foreground shrink-0" />
          <span className="truncate text-sm font-medium">
            {state.kind === 'ready' ? state.cwd : 'Terminal'}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onClearTarget ? (
            <Button
              data-testid="terminal-panel-clear-target"
              onClick={onClearTarget}
              size="sm"
              title="Stop pinning this terminal to a specific checkout"
              type="button"
              variant="outline"
            >
              Follow focused folder
            </Button>
          ) : null}
          {isExited || isError ? (
            <Button onClick={restart} size="sm" type="button" variant="outline">
              <RotateCw aria-hidden="true" className="mr-1" />
              Restart
            </Button>
          ) : null}
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {/* The xterm host. role="application" matches the interactive,
            keyboard-driven terminal widget (xterm renders its own a11y tree —
            a live-region + textarea — inside) and supports the accessible label;
            it has no semantic-HTML equivalent, so it is the correct role here. */}
        <div
          aria-label="Terminal"
          className="text-foreground h-full w-full px-2 py-1"
          data-testid="terminal-host"
          ref={containerRef}
          role="application"
        />

        {isExited ? (
          <div
            className="bg-background/80 absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-sm"
            data-testid="terminal-panel-exited"
          >
            <p className="text-muted-foreground">
              {`Shell exited (code ${state.exitCode}${
                state.signal === null ? '' : `, signal ${state.signal}`
              }).`}
            </p>
            <Button onClick={restart} size="sm" type="button" variant="outline">
              <RotateCw aria-hidden="true" className="mr-1" />
              Restart terminal
            </Button>
          </div>
        ) : null}

        {isError ? (
          <div
            className="bg-background/80 absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-sm"
            data-testid="terminal-panel-error"
          >
            <p className="text-destructive">Could not start the terminal.</p>
            <p className="text-muted-foreground max-w-md text-xs">{state.message}</p>
            <Button onClick={restart} size="sm" type="button" variant="outline">
              <RotateCw aria-hidden="true" className="mr-1" />
              Retry
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function TerminalPanel(): ReactElement {
  const focusedRootId = useActiveRootId();
  const target = useTerminalTargetStore((state) => state.target);
  const clearTarget = useTerminalTargetStore((state) => state.reset);
  const commandSessionsAvailable = useCommandSessionBridge() !== null;
  const [surface, setSurface] = useState<'command-sessions' | 'shell'>('shell');
  // An explicit pin wins; with none the panel follows the focused root exactly
  // as it always has. Derived during render — never mirrored into state.
  const rootId = target?.rootId ?? focusedRootId;

  // An explicit "Open in Terminal" must show the shell it just started, even
  // when Command sessions was the last surface selected — otherwise the
  // requested PTY starts invisibly behind that tab (PR #2675 review). Render-time
  // adjustment per the house "derived state" idiom (budget-settings-panel.tsx,
  // threads-panel-search.tsx): `openTerminalAt` always sets a FRESH object, so
  // its identity changes on every call, including a repeat pin of the same
  // checkout. The user can still switch back to Command sessions afterward —
  // this only forces the surface at the moment a new target is requested.
  const [lastHandledTarget, setLastHandledTarget] = useState<TerminalTarget | null>(target);
  if (target !== lastHandledTarget) {
    setLastHandledTarget(target);
    if (target) {
      setSurface('shell');
    }
  }

  if (!rootId) {
    return (
      <div
        className="bg-background text-muted-foreground flex h-full items-center justify-center p-6 text-center text-sm"
        data-testid="terminal-panel-no-root"
      >
        Open a workspace folder to run a shell in it.
      </div>
    );
  }

  return (
    <div className="bg-background flex h-full min-h-0 flex-col" data-testid="terminal-panel">
      {commandSessionsAvailable ? (
        <nav
          aria-label="Terminal surfaces"
          className="border-border flex gap-1 border-b px-2 py-1.5"
        >
          <Button
            aria-current={surface === 'shell' ? 'page' : undefined}
            onClick={() => setSurface('shell')}
            size="sm"
            type="button"
            variant={surface === 'shell' ? 'secondary' : 'ghost'}
          >
            <TerminalSquare aria-hidden="true" className="mr-1" /> Shell
          </Button>
          <Button
            aria-current={surface === 'command-sessions' ? 'page' : undefined}
            onClick={() => setSurface('command-sessions')}
            size="sm"
            type="button"
            variant={surface === 'command-sessions' ? 'secondary' : 'ghost'}
          >
            <Bot aria-hidden="true" className="mr-1" /> Command sessions
          </Button>
        </nav>
      ) : null}
      <div className="min-h-0 flex-1" hidden={surface !== 'shell'}>
        <HumanTerminal
          cwd={target?.cwd ?? null}
          onClearTarget={target ? clearTarget : undefined}
          rootId={rootId}
        />
      </div>
      {commandSessionsAvailable && focusedRootId ? (
        <div className="min-h-0 flex-1" hidden={surface !== 'command-sessions'}>
          {/* A pin is a SHELL pin by design — Command sessions always follows
              the FOCUSED root, never the pinned `rootId`, so a checkout pinned
              in another root can never silently retarget this surface's
              destructive stop/remove/write actions (PR #2675 review). */}
          <CommandSessionInventory key={focusedRootId} rootId={focusedRootId} />
        </div>
      ) : null}
    </div>
  );
}
