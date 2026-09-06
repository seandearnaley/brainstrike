/**
 * Settings → Tools: the global off switch for registered MCP client extensions
 * (BST-1604).
 *
 * Both registered extensions ship ON. This section drives the GLOBAL dial owned
 * by the desktop main process; the per-server `extensions` overrides in the MCP
 * config document are the other half, and the effective state is
 * `global AND per-server` (see `resolveMcpExtensionEnablement`).
 *
 * The switch reflects the PERSISTED state only: it does not move optimistically,
 * so a rejected write never silently reverts a switch the user believes landed.
 * A failed read or write renders a visible alert instead of degrading to the
 * compiled-in default (NO SILENT FALLBACKS).
 */

import {
  MCP_EXTENSION_ID_BY_KEY,
  MCP_EXTENSION_KEYS,
  MCP_EXTENSION_LABEL_BY_KEY,
  type McpExtensionEnablement,
  type McpExtensionKey,
} from '@brainstrike/assistant-contract';
import { Label, Switch } from '@brainstrike/ui';
import { useCallback, useEffect, useState } from 'react';

const READ_FAILURE_FALLBACK = 'Failed to read MCP extension preferences';
const WRITE_FAILURE_FALLBACK = 'Failed to save MCP extension preferences';

function failureMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

export function McpExtensionSettings({
  getPreferences,
  onPreferencesChange,
  setPreferences,
  subscribe,
}: {
  readonly getPreferences: () => Promise<McpExtensionEnablement>;
  /**
   * Mirrors the loaded/pushed/saved state to the parent so the protocol support
   * matrix can render the EFFECTIVE global state rather than the compiled-in
   * default. Must be referentially stable (a `useState` setter qualifies) —
   * it participates in the load effect's dependencies.
   */
  readonly onPreferencesChange?: ((preferences: McpExtensionEnablement) => void) | undefined;
  readonly setPreferences: (preferences: McpExtensionEnablement) => Promise<McpExtensionEnablement>;
  readonly subscribe?:
    | ((listener: (preferences: McpExtensionEnablement) => void) => () => void)
    | undefined;
}) {
  const [preferences, setLoadedPreferences] = useState<McpExtensionEnablement | null>(null);
  const [pendingKey, setPendingKey] = useState<McpExtensionKey | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  /** The single place persisted state lands: initial read, push, and write. */
  const applyPreferences = useCallback(
    (next: McpExtensionEnablement) => {
      setErrorMessage(null);
      setLoadedPreferences(next);
      onPreferencesChange?.(next);
    },
    [onPreferencesChange]
  );

  // One lifecycle: the push subscription is armed before the initial read
  // resolves, so a change landing mid-read is never dropped.
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = subscribe?.(applyPreferences);
    getPreferences().then(
      (loaded) => {
        if (!cancelled) {
          applyPreferences(loaded);
        }
      },
      (cause: unknown) => {
        if (!cancelled) {
          setErrorMessage(failureMessage(cause, READ_FAILURE_FALLBACK));
        }
      }
    );
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [applyPreferences, getPreferences, subscribe]);

  const toggle = (key: McpExtensionKey, enabled: boolean): void => {
    if (preferences === null || pendingKey !== null) {
      return;
    }
    setPendingKey(key);
    setErrorMessage(null);
    setPreferences({ ...preferences, [key]: enabled }).then(
      (saved) => {
        applyPreferences(saved);
        setPendingKey(null);
      },
      (cause: unknown) => {
        setErrorMessage(failureMessage(cause, WRITE_FAILURE_FALLBACK));
        setPendingKey(null);
      }
    );
  };

  return (
    <section
      aria-labelledby="mcp-extension-settings-title"
      className="space-y-2"
      data-testid="mcp-extension-settings"
    >
      <div>
        <h3 className="font-medium text-sm" id="mcp-extension-settings-title">
          Registered MCP extensions
        </h3>
        <p className="text-muted-foreground text-xs">
          On by default. Turning one off stops it being advertised on the next connection, and
          sessions still using it are retired.
        </p>
      </div>
      {errorMessage && (
        <div className="text-destructive text-xs" role="alert">
          {errorMessage}
        </div>
      )}
      <div className="space-y-2">
        {MCP_EXTENSION_KEYS.map((key) => {
          const toggleId = `mcp-extension-toggle-${key}`;
          return (
            <div
              className="flex items-start justify-between gap-4 rounded-md border px-3 py-2"
              data-testid={`mcp-extension-row-${key}`}
              key={key}
            >
              <div className="min-w-0 space-y-0.5">
                <Label className="font-medium text-sm" htmlFor={toggleId}>
                  {MCP_EXTENSION_LABEL_BY_KEY[key]}
                </Label>
                <div className="break-all font-mono text-muted-foreground text-xs">
                  {MCP_EXTENSION_ID_BY_KEY[key]}
                </div>
              </div>
              <Switch
                aria-busy={pendingKey === key}
                checked={preferences?.[key] ?? true}
                data-testid={toggleId}
                disabled={preferences === null || pendingKey !== null}
                id={toggleId}
                onCheckedChange={(value) => toggle(key, value === true)}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
