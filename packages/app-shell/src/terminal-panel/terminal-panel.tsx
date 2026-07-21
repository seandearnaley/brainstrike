import { Button } from '@brainstrike/ui';
import { Bot, RotateCw, TerminalSquare } from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { isCommandSessionBridgeAvailable } from './command-session-bridge';
import { CommandSessionInventory } from './command-session-inventory';
import { useActiveRootId } from './use-active-root-id';
import { useTerminalSession } from './use-terminal-session';

/**
 * Desktop terminal surface. Runs a REAL interactive shell in the focused
 * workspace root via the `window.terminal` pty bridge, rendered with xterm.js.
 *
 * All bridge interaction + the imperative xterm lifecycle live in
 * {@link useTerminalSession}; this component resolves the active root, mounts the
 * xterm host element, and renders the discriminated session state (starting /
 * ready / exited-with-restart / error). Every failure is a visible state + toast
 * inside the hook — never a blank panel.
 *
 * Constructed only on desktop (the wrapper checks `window.terminal`); it still
 * renders its own no-root empty state. On a root focus-change the existing
 * session keeps running (it is pinned to its cwd); switching the active root
 * starts a fresh session for the newly focused root.
 */
interface HumanTerminalProps {
  readonly activeRootId: string;
}

function HumanTerminal({ activeRootId }: HumanTerminalProps): ReactElement {
  const { containerRef, restart, state } = useTerminalSession(activeRootId);

  const isExited = state.kind === 'exited';
  const isError = state.kind === 'error';

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center justify-between gap-2 border-border border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <TerminalSquare aria-hidden="true" className="shrink-0 text-muted-foreground" />
          <span className="truncate font-medium text-sm">
            {state.kind === 'ready' ? state.cwd : 'Terminal'}
          </span>
        </div>
        {isExited || isError ? (
          <Button onClick={restart} size="sm" type="button" variant="outline">
            <RotateCw aria-hidden="true" className="mr-1" />
            Restart
          </Button>
        ) : null}
      </div>

      <div className="relative min-h-0 flex-1">
        {/* The xterm host. role="application" matches the interactive,
            keyboard-driven terminal widget (xterm renders its own a11y tree —
            a live-region + textarea — inside) and supports the accessible label;
            it has no semantic-HTML equivalent, so it is the correct role here. */}
        <div
          aria-label="Terminal"
          className="h-full w-full px-2 py-1 text-foreground"
          data-testid="terminal-host"
          ref={containerRef}
          role="application"
        />

        {isExited ? (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/80 p-6 text-center text-sm"
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
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/80 p-6 text-center text-sm"
            data-testid="terminal-panel-error"
          >
            <p className="text-destructive">Could not start the terminal.</p>
            <p className="max-w-md text-muted-foreground text-xs">{state.message}</p>
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
  const activeRootId = useActiveRootId();
  const commandSessionsAvailable = useMemo(() => isCommandSessionBridgeAvailable(), []);
  const [surface, setSurface] = useState<'command-sessions' | 'shell'>('shell');

  if (!activeRootId) {
    return (
      <div
        className="flex h-full items-center justify-center bg-background p-6 text-center text-muted-foreground text-sm"
        data-testid="terminal-panel-no-root"
      >
        Open a workspace folder to run a shell in it.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="terminal-panel">
      {commandSessionsAvailable ? (
        <nav
          aria-label="Terminal surfaces"
          className="flex gap-1 border-border border-b px-2 py-1.5"
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
        <HumanTerminal activeRootId={activeRootId} />
      </div>
      {commandSessionsAvailable ? (
        <div className="min-h-0 flex-1" hidden={surface !== 'command-sessions'}>
          <CommandSessionInventory key={activeRootId} rootId={activeRootId} />
        </div>
      ) : null}
    </div>
  );
}
