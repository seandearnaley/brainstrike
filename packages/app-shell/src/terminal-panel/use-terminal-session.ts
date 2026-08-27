import { createLogger } from '@brainstrike/logging';
import { useToast } from '@brainstrike/ui';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isTransientRootError,
  TRANSIENT_ROOT_RETRY_DELAY_MS,
  TRANSIENT_ROOT_RETRY_LIMIT,
} from '../roots/transient-root-error';
import { SurrogateBuffer } from './surrogate-buffer';
import { resolveTerminalBridge, type TerminalBridge } from './terminal-bridge';
import { XTERM_THEME } from './xterm-theme';

const logger = createLogger('TerminalPanel');

/**
 * Log an IPC-level rejection from a fire-and-forget bridge call. The
 * `TerminalResult` envelope never throws, but the underlying transport can (e.g.
 * the bridge tears down mid-call); without this the rejection would be an
 * unhandled promise rejection rather than a logged warning.
 */
function warnBridgeRejection(op: string): (error: unknown) => void {
  return (error: unknown) => {
    logger.warn('terminal bridge call rejected', {
      error: error instanceof Error ? error.message : String(error),
      op,
    });
  };
}

/**
 * Discriminated session lifecycle.
 *
 * `idle` (no bridge/root) and `starting` (a session is being set up) are DERIVED
 * during render — never written by the effect. The effect only records the async
 * OUTCOME of the external session (ready / exited / error), tagged with the
 * session id it belongs to, so it is a legitimate "subscribe to an external
 * system" effect and not a derived-state mirror (which react-doctor's
 * `no-adjust-state-on-prop-change` flags).
 */
export type TerminalSessionState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'ready'; cwd: string }
  | { kind: 'exited'; exitCode: number; signal: number | null }
  | { kind: 'error'; message: string };

/** The async outcome the effect records, tagged with its session id. */
type SessionOutcome =
  | { kind: 'ready'; cwd: string }
  | { kind: 'exited'; exitCode: number; signal: number | null }
  | { kind: 'error'; message: string };

interface TaggedOutcome {
  readonly outcome: SessionOutcome;
  readonly sessionId: number;
  /**
   * The (rootId, cwd) PAIR this outcome belongs to, joined by a NUL that
   * neither component can contain. The lifecycle effect re-runs on a root
   * switch OR a target-pin change WITHOUT bumping `sessionId`, so the
   * render-time freshness gate must key on both — otherwise the previous
   * checkout's `exited`/`error` outcome leaks onto the freshly-starting one
   * until its `create()` resolves.
   */
  readonly sessionKey: string;
}

export interface UseTerminalSessionResult {
  /** Ref callback for the xterm host element. Drives session (re)mount. */
  readonly containerRef: (node: HTMLDivElement | null) => void;
  /** Restart a session that has exited or failed (fresh pty + xterm). */
  readonly restart: () => void;
  readonly state: TerminalSessionState;
}

/** Min interval (ms) between resize→fit→bridge.resize commits while dragging. */
const RESIZE_DEBOUNCE_MS = 100;

/** Every timer/subscription the lifecycle effect below can own, at the point cleanup runs. */
interface TerminalSessionHandles {
  readonly offData: (() => void) | null;
  readonly offExit: (() => void) | null;
  readonly offInput: (() => void) | null;
  readonly resizeObserver: ResizeObserver | null;
  readonly resizeTimer: ReturnType<typeof setTimeout> | null;
  readonly retryTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Tears down every timer/subscription the lifecycle effect below may have
 * created, pulled out of the effect's own `return () => {...}` so THAT
 * function stays a single, low-complexity call to this one rather than six
 * inline null-checks. Each handle is independently nullable because the
 * effect can unmount before any of them were ever created (e.g. `cancelled`
 * before `bridge.create()` resolves).
 */
function disposeTerminalSessionHandles(handles: TerminalSessionHandles): void {
  if (handles.retryTimer !== null) {
    clearTimeout(handles.retryTimer);
  }
  if (handles.resizeTimer !== null) {
    clearTimeout(handles.resizeTimer);
  }
  if (handles.resizeObserver !== null) {
    handles.resizeObserver.disconnect();
  }
  if (handles.offData !== null) {
    handles.offData();
  }
  if (handles.offExit !== null) {
    handles.offExit();
  }
  if (handles.offInput !== null) {
    handles.offInput();
  }
}

/**
 * Owns the imperative xterm Terminal + `window.terminal` pty session for ONE
 * checkout — the focused workspace root, or a pinned target inside it
 * (`terminal-target-store`).
 *
 * Lifecycle (a single effect keyed on the host element + rootId + a session id):
 *   1. construct an xterm `Terminal` + `FitAddon`, `open()` it on the host node;
 *   2. `bridge.create({ rootId, cwd, cols, rows })` → on `{ ok:false }` record an
 *      error outcome + toast (never a blank panel);
 *   3. `bridge.onData` → surrogate-safe reassembly → `term.write()`;
 *   4. `term.onData` (keystrokes) → `bridge.write({ terminalId, data })`;
 *   5. a `ResizeObserver` → `fit()` → `bridge.resize({ terminalId, cols, rows })`;
 *   6. `bridge.onExit` → exited outcome (offer restart);
 *   7. cleanup: unsubscribe all, `bridge.destroy({ terminalId })`, dispose the
 *      Terminal + observer.
 *
 * The `bridge` is resolved once (the preload bridge lives for the window's
 * lifetime). When absent the hook is inert (`idle`) and the panel renders its
 * desktop-only empty state.
 */
export function useTerminalSession(
  rootId: string | null,
  cwd: string | null
): UseTerminalSessionResult {
  const { toast } = useToast();
  const bridgeRef = useRef<TerminalBridge | null>(null);
  if (bridgeRef.current === null) {
    bridgeRef.current = resolveTerminalBridge();
  }
  const bridge = bridgeRef.current;
  // Derived during render, never stored: the identity of the session the panel
  // WANTS. NUL-joined because neither a rootId (uuid) nor an absolute path can
  // contain it, so no two distinct pairs can collide into one key.
  const sessionKey = `${rootId ?? ''}\u0000${cwd ?? ''}`;

  // The host element is tracked in state (not a plain ref) so the lifecycle
  // effect re-runs when the node mounts/unmounts — a ref mutation would not.
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const containerRef = useCallback((node: HTMLDivElement | null) => {
    setContainer(node);
  }, []);

  // A monotonically-increasing id for the CURRENT desired session. Bumping it
  // (restart) re-keys the effect and invalidates any stale outcome. This is the
  // only "input" state — it is not derived from props.
  const [sessionId, setSessionId] = useState(0);
  // Counts consecutive transient "root not reconciled yet" create failures so
  // the silent boot-race retry loop is bounded. Reset on success, on a manual
  // restart, and when the focused root changes.
  const transientRetryCountRef = useRef(0);
  const restart = useCallback(() => {
    transientRetryCountRef.current = 0;
    setSessionId((id) => id + 1);
  }, []);

  // A different target (root or pinned checkout) starts with a fresh
  // transient-retry budget.
  useEffect(() => {
    transientRetryCountRef.current = 0;
  }, [sessionKey]);

  // The async OUTCOME of a session, tagged with the id it belongs to. The effect
  // writes only this (a subscribe-to-external-system result), never a derived
  // value. A stale outcome (sessionId mismatch) is ignored during render.
  const [tagged, setTagged] = useState<TaggedOutcome | null>(null);

  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup -- Confirmed pre-existing on the PR base tip (3d54958160, full-scope scan reproduces it there too); scope-changed's line-shift-sensitive diff misclassifies it as new whenever code above this effect moves. The rule's own docs name this exact failure mode ("descends into every nested function" to find registrations but checks only the top-level/returned function for cleanup) and its explicit skip criterion: "A returned cleanup does release the resource even if the matcher missed it" -- which this one does, for every handle (retryTimer, resizeTimer, resizeObserver, offData, offExit, offInput) via disposeTerminalSessionHandles() below. The resizeObserver branch is spy-tested: terminal-panel.test.tsx's "unsubscribes and destroys the pty on unmount" asserts resizeObserverDisconnect was called.
  useEffect(() => {
    if (!(bridge && rootId && container)) {
      return;
    }

    let cancelled = false;
    let terminalId: string | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // Every subscription/timer this effect can create is hoisted to THIS
    // scope (never declared inside the `.then()` success branch below) so
    // the cleanup at the bottom has one textually-visible teardown call per
    // allocation — no dynamically-built array of closures for a static
    // reader (human or tool) to trace through.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let offData: (() => void) | null = null;
    let offExit: (() => void) | null = null;
    let offInput: (() => void) | null = null;

    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: XTERM_THEME,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(container);
    try {
      fitAddon.fit();
    } catch {
      // proposeDimensions can throw if the node is detached/zero-size; the
      // backend defaults (80x24) apply until the first ResizeObserver tick.
    }

    bridge
      .create({ cols: term.cols, rootId, rows: term.rows, ...(cwd === null ? {} : { cwd }) })
      .then((result) => {
        if (cancelled) {
          // Created after teardown: reap the orphan pty rather than leak it.
          if (result.ok) {
            void bridge
              .destroy({ terminalId: result.value.terminalId })
              .catch(warnBridgeRejection('destroy'));
          }
          return;
        }
        if (!result.ok) {
          if (
            isTransientRootError(result.error) &&
            transientRetryCountRef.current < TRANSIENT_ROOT_RETRY_LIMIT
          ) {
            // Boot race: the workspace root row hasn't reconciled into the DB
            // yet. Stay in the 'starting' state and re-key the session shortly
            // — no error UI, no toast — until it lands or the budget runs out.
            transientRetryCountRef.current += 1;
            logger.debug('terminal create waiting for workspace root reconciliation', {
              attempt: transientRetryCountRef.current,
              error: result.error,
            });
            retryTimer = setTimeout(() => {
              if (!cancelled) {
                setSessionId((id) => id + 1);
              }
            }, TRANSIENT_ROOT_RETRY_DELAY_MS);
            return;
          }
          setTagged({
            outcome: { kind: 'error', message: result.error },
            sessionId,
            sessionKey,
          });
          logger.error('terminal create failed', { error: result.error });
          toast({
            description: result.error,
            title: 'Terminal failed to start',
            variant: 'destructive',
          });
          return;
        }

        transientRetryCountRef.current = 0;
        terminalId = result.value.terminalId;
        const liveId = terminalId;
        setTagged({
          outcome: { cwd: result.value.cwd, kind: 'ready' },
          sessionId,
          sessionKey,
        });

        // pty output → surrogate-safe reassembly → xterm.
        const surrogates = new SurrogateBuffer();
        offData = bridge.onData((event) => {
          if (event.terminalId !== liveId) {
            return;
          }
          term.write(surrogates.push(event.data));
        });

        // pty exit → exit outcome (the panel offers a restart).
        offExit = bridge.onExit((event) => {
          if (event.terminalId !== liveId) {
            return;
          }
          // Flush any deferred surrogate so the final bytes are not dropped.
          const tail = surrogates.flush();
          if (tail) {
            term.write(tail);
          }
          setTagged({
            outcome: { exitCode: event.exitCode, kind: 'exited', signal: event.signal },
            sessionId,
            sessionKey,
          });
        });

        // keystrokes → pty. A `{ ok:false }` write (dead pty) surfaces once; an
        // IPC-level rejection (bridge torn down mid-keystroke) is logged, not left
        // as an unhandled rejection on this hot path.
        const inputDisposable = term.onData((data: string) => {
          void bridge
            .write({ data, terminalId: liveId })
            .then((writeResult) => {
              if (!writeResult.ok) {
                logger.warn('terminal write failed', { error: writeResult.error });
              }
            })
            .catch(warnBridgeRejection('write'));
        });
        offInput = () => inputDisposable.dispose();

        // Container resize → fit → pty resize (debounced so a drag does not spam).
        // `resizeTimer`/`resizeObserver` are the OUTER, effect-scoped bindings
        // declared above — not re-declared here — so the main cleanup below
        // can clear/disconnect them directly, the same way it already does
        // for `retryTimer`.
        const commitResize = () => {
          resizeTimer = null;
          try {
            fitAddon.fit();
          } catch {
            return;
          }
          void bridge
            .resize({ cols: term.cols, rows: term.rows, terminalId: liveId })
            .catch(warnBridgeRejection('resize'));
        };
        resizeObserver = new ResizeObserver(() => {
          if (resizeTimer !== null) {
            clearTimeout(resizeTimer);
          }
          resizeTimer = setTimeout(commitResize, RESIZE_DEBOUNCE_MS);
        });
        resizeObserver.observe(container);

        term.focus();
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setTagged({ outcome: { kind: 'error', message }, sessionId, sessionKey });
        logger.error('terminal create threw', { error: message });
        toast({ description: message, title: 'Terminal failed to start', variant: 'destructive' });
      });

    return () => {
      cancelled = true;
      disposeTerminalSessionHandles({
        offData,
        offExit,
        offInput,
        resizeObserver,
        resizeTimer,
        retryTimer,
      });
      if (terminalId) {
        void bridge.destroy({ terminalId }).catch(warnBridgeRejection('destroy'));
      }
      term.dispose();
    };
  }, [bridge, rootId, cwd, container, sessionId, sessionKey, toast]);

  // Derive the displayed state during render (no effect mirror):
  //  - no bridge/root → idle;
  //  - a fresh outcome for the CURRENT session AND target → that outcome;
  //  - otherwise the session is still being set up → starting.
  let state: TerminalSessionState;
  if (!(bridge && rootId)) {
    state = { kind: 'idle' };
  } else if (tagged?.sessionId === sessionId && tagged.sessionKey === sessionKey) {
    state = tagged.outcome;
  } else {
    state = { kind: 'starting' };
  }

  return { containerRef, restart, state };
}
