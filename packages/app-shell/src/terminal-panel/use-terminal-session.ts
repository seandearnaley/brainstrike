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
      fontSize: 13,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      theme: XTERM_THEME,
      scrollback: 5000,
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
      .create({ rootId: activeRootId, cols: term.cols, rows: term.rows })
      .then((result) => {
        if (cancelled) {
          // Created after teardown: reap the orphan pty rather than leak it.
          if (result.ok) {
            void bridge.destroy({ terminalId: result.value.terminalId });
          }
          return;
        }
        if (!result.ok) {
          setTagged({ sessionId, outcome: { kind: 'error', message: result.error } });
          logger.error('terminal create failed', { error: result.error });
          toast({
            title: 'Terminal failed to start',
            description: result.error,
            variant: 'destructive',
          });
          return;
        }

        terminalId = result.value.terminalId;
        const liveId = terminalId;
        setTagged({ sessionId, outcome: { kind: 'ready', cwd: result.value.cwd } });

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
            sessionId,
            outcome: { kind: 'exited', exitCode: event.exitCode, signal: event.signal },
          });
        });
        disposers.push(offExit);

        // keystrokes → pty. A `{ ok:false }` write (dead pty) surfaces once.
        const onInput = term.onData((data: string) => {
          void bridge.write({ terminalId: liveId, data }).then((writeResult) => {
            if (!writeResult.ok) {
              logger.warn('terminal write failed', { error: writeResult.error });
            }
          });
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
          void bridge.resize({ terminalId: liveId, cols: term.cols, rows: term.rows });
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
        setTagged({ sessionId, outcome: { kind: 'error', message } });
        logger.error('terminal create threw', { error: message });
        toast({ title: 'Terminal failed to start', description: message, variant: 'destructive' });
      });

    return () => {
      cancelled = true;
      for (const dispose of disposers) {
        dispose();
      }
      if (terminalId) {
        void bridge.destroy({ terminalId });
      }
      term.dispose();
    };
  }, [bridge, activeRootId, container, sessionId, toast]);

  // Derive the displayed state during render (no effect mirror):
  //  - no bridge/root → idle;
  //  - a fresh outcome for the CURRENT session → that outcome;
  //  - otherwise the session is still being set up → starting.
  let state: TerminalSessionState;
  if (!(bridge && activeRootId)) {
    state = { kind: 'idle' };
  } else if (tagged?.sessionId === sessionId) {
    state = tagged.outcome;
  } else {
    state = { kind: 'starting' };
  }

  return { containerRef, restart, state };
}
