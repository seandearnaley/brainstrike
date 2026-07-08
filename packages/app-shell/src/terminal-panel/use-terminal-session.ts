import { useToast } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useRef, useState } from 'react';
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
  /**
   * The root this outcome belongs to. The lifecycle effect re-runs on a root
   * switch (deps include `activeRootId`) WITHOUT bumping `sessionId`, so the
   * render-time freshness gate must key on both — otherwise the previous root's
   * `exited`/`error` outcome leaks onto the freshly-starting root until its
   * `create()` resolves.
   */
  readonly rootId: string;
  readonly sessionId: number;
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

/**
 * Owns the imperative xterm Terminal + `window.terminal` pty session for ONE
 * workspace root.
 *
 * Lifecycle (a single effect keyed on the host element + rootId + a session id):
 *   1. construct an xterm `Terminal` + `FitAddon`, `open()` it on the host node;
 *   2. `bridge.create({ rootId, cols, rows })` → on `{ ok:false }` record an
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
export function useTerminalSession(activeRootId: string | null): UseTerminalSessionResult {
  const { toast } = useToast();
  const bridgeRef = useRef<TerminalBridge | null>(null);
  if (bridgeRef.current === null) {
    bridgeRef.current = resolveTerminalBridge();
  }
  const bridge = bridgeRef.current;

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
  const restart = useCallback(() => {
    setSessionId((id) => id + 1);
  }, []);

  // The async OUTCOME of a session, tagged with the id it belongs to. The effect
  // writes only this (a subscribe-to-external-system result), never a derived
  // value. A stale outcome (sessionId mismatch) is ignored during render.
  const [tagged, setTagged] = useState<TaggedOutcome | null>(null);

  useEffect(() => {
    if (!(bridge && activeRootId && container)) {
      return;
    }

    let cancelled = false;
    let terminalId: string | null = null;
    const disposers: Array<() => void> = [];

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
      .create({ cols: term.cols, rootId: activeRootId, rows: term.rows })
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
          setTagged({
            outcome: { kind: 'error', message: result.error },
            rootId: activeRootId,
            sessionId,
          });
          logger.error('terminal create failed', { error: result.error });
          toast({
            description: result.error,
            title: 'Terminal failed to start',
            variant: 'destructive',
          });
          return;
        }

        terminalId = result.value.terminalId;
        const liveId = terminalId;
        setTagged({
          outcome: { cwd: result.value.cwd, kind: 'ready' },
          rootId: activeRootId,
          sessionId,
        });

        // pty output → surrogate-safe reassembly → xterm.
        const surrogates = new SurrogateBuffer();
        const offData = bridge.onData((event) => {
          if (event.terminalId !== liveId) {
            return;
          }
          term.write(surrogates.push(event.data));
        });
        disposers.push(offData);

        // pty exit → exit outcome (the panel offers a restart).
        const offExit = bridge.onExit((event) => {
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
            rootId: activeRootId,
            sessionId,
          });
        });
        disposers.push(offExit);

        // keystrokes → pty. A `{ ok:false }` write (dead pty) surfaces once; an
        // IPC-level rejection (bridge torn down mid-keystroke) is logged, not left
        // as an unhandled rejection on this hot path.
        const onInput = term.onData((data: string) => {
          void bridge
            .write({ data, terminalId: liveId })
            .then((writeResult) => {
              if (!writeResult.ok) {
                logger.warn('terminal write failed', { error: writeResult.error });
              }
            })
            .catch(warnBridgeRejection('write'));
        });
        disposers.push(() => onInput.dispose());

        // Container resize → fit → pty resize (debounced so a drag does not spam).
        let resizeTimer: ReturnType<typeof setTimeout> | null = null;
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
        const observer = new ResizeObserver(() => {
          if (resizeTimer !== null) {
            clearTimeout(resizeTimer);
          }
          resizeTimer = setTimeout(commitResize, RESIZE_DEBOUNCE_MS);
        });
        observer.observe(container);
        disposers.push(() => {
          if (resizeTimer !== null) {
            clearTimeout(resizeTimer);
          }
          observer.disconnect();
        });

        term.focus();
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setTagged({ outcome: { kind: 'error', message }, rootId: activeRootId, sessionId });
        logger.error('terminal create threw', { error: message });
        toast({ description: message, title: 'Terminal failed to start', variant: 'destructive' });
      });

    return () => {
      cancelled = true;
      for (const dispose of disposers) {
        dispose();
      }
      if (terminalId) {
        void bridge.destroy({ terminalId }).catch(warnBridgeRejection('destroy'));
      }
      term.dispose();
    };
  }, [bridge, activeRootId, container, sessionId, toast]);

  // Derive the displayed state during render (no effect mirror):
  //  - no bridge/root → idle;
  //  - a fresh outcome for the CURRENT session AND root → that outcome;
  //  - otherwise the session is still being set up → starting.
  // The gate keys on both `sessionId` and `activeRootId`: the lifecycle effect
  // re-runs on a root switch without bumping `sessionId`, so an outcome tagged
  // with the prior root must NOT surface for the newly-focused one.
  let state: TerminalSessionState;
  if (!(bridge && activeRootId)) {
    state = { kind: 'idle' };
  } else if (tagged?.sessionId === sessionId && tagged.rootId === activeRootId) {
    state = tagged.outcome;
  } else {
    state = { kind: 'starting' };
  }

  return { containerRef, restart, state };
}
