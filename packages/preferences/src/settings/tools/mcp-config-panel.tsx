import { Button, Card, CardContent, Input } from '@brainstrike/ui';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ToolsSettingsOperations } from './types';

interface McpConfigPanelProps {
  operations: ToolsSettingsOperations;
  onConfigChanged: () => Promise<void>;
}

const WINDOWS_DRIVE_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/u;
const WINDOWS_UNC_PATH = /^\\\\/u;
const MCP_CONFIG_STATUS_ID = 'mcp-config-status-message';
const MCP_CONFIG_ERROR_ID = 'mcp-config-error-message';

function isAbsoluteFilePath(filePath: string): boolean {
  return (
    filePath.startsWith('/') ||
    WINDOWS_DRIVE_ABSOLUTE_PATH.test(filePath) ||
    WINDOWS_UNC_PATH.test(filePath)
  );
}

export function McpConfigPanel({ operations, onConfigChanged }: McpConfigPanelProps) {
  const [pathDraft, setPathDraft] = useState('');
  const [editorValue, setEditorValue] = useState('');
  const [savedValue, setSavedValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showReloadConfirm, setShowReloadConfirm] = useState(false);

  const editorAvailable = useMemo(
    () => Boolean(operations.readMcpConfigText && operations.writeMcpConfigText),
    [operations.readMcpConfigText, operations.writeMcpConfigText]
  );
  // Keep loadDocument stable while still using the latest operation callback from props.
  const readMcpConfigTextRef = useRef(operations.readMcpConfigText);

  useEffect(() => {
    readMcpConfigTextRef.current = operations.readMcpConfigText;
  }, [operations.readMcpConfigText]);

  const hasUnsavedChanges = editorValue !== savedValue;

  const loadDocument = useCallback(async () => {
    const readMcpConfigText = readMcpConfigTextRef.current;
    if (!readMcpConfigText) {
      return;
    }

    setLoading(true);
    setShowReloadConfirm(false);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const doc = await readMcpConfigText();
      setPathDraft(doc.path);
      setEditorValue(doc.content);
      setSavedValue(doc.content);
      if (doc.created) {
        setStatusMessage('Created a new MCP config template with commented examples.');
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load MCP config');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!editorAvailable) {
      return;
    }
    void loadDocument();
  }, [editorAvailable, loadDocument]);

  const handleApplyPath = useCallback(async () => {
    if (!operations.setMcpConfigPath) {
      return;
    }

    try {
      setErrorMessage(null);
      setStatusMessage(null);
      const nextPath = pathDraft.trim();
      if (nextPath.length > 0 && !isAbsoluteFilePath(nextPath)) {
        setErrorMessage('Please provide an absolute path to the MCP config file.');
        return;
      }
      await operations.setMcpConfigPath(nextPath.length > 0 ? nextPath : null);
      await onConfigChanged();
      await loadDocument();
      setStatusMessage('MCP config path updated.');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to update MCP config path');
    }
  }, [loadDocument, onConfigChanged, operations.setMcpConfigPath, pathDraft]);

  const handleBrowse = useCallback(async () => {
    if (!operations.openMcpConfig) {
      return;
    }

    try {
      setErrorMessage(null);
      setStatusMessage(null);
      await operations.openMcpConfig();
      await onConfigChanged();
      await loadDocument();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to open MCP config picker');
    }
  }, [loadDocument, onConfigChanged, operations.openMcpConfig]);

  const handleResetPath = useCallback(async () => {
    if (!operations.resetMcpConfig) {
      return;
    }

    try {
      setErrorMessage(null);
      setStatusMessage(null);
      await operations.resetMcpConfig();
      await onConfigChanged();
      await loadDocument();
      setStatusMessage('MCP config path reset to default.');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to reset MCP config path');
    }
  }, [loadDocument, onConfigChanged, operations.resetMcpConfig]);

  const handleSave = useCallback(async () => {
    if (!operations.writeMcpConfigText) {
      return;
    }

    try {
      setErrorMessage(null);
      setStatusMessage(null);
      const result = await operations.writeMcpConfigText(editorValue);
      if (!result.success) {
        setErrorMessage(result.error);
        return;
      }
      setSavedValue(editorValue);
      setShowReloadConfirm(false);
      setStatusMessage('MCP config saved.');
      await onConfigChanged();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to save MCP config');
    }
  }, [editorValue, onConfigChanged, operations.writeMcpConfigText]);

  const handleEditorKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (!loading && hasUnsavedChanges) {
          void handleSave();
        }
      }
    },
    [handleSave, hasUnsavedChanges, loading]
  );

  const handleReload = useCallback(async () => {
    if (hasUnsavedChanges) {
      setShowReloadConfirm(true);
      return;
    }

    await loadDocument();
  }, [hasUnsavedChanges, loadDocument]);

  const handleConfirmReload = useCallback(async () => {
    setShowReloadConfirm(false);
    await loadDocument();
  }, [loadDocument]);

  const handleCancelReload = useCallback(() => {
    setShowReloadConfirm(false);
  }, []);

  const editorDescribedBy = useMemo(() => {
    const ids: string[] = [];
    if (statusMessage) {
      ids.push(MCP_CONFIG_STATUS_ID);
    }
    if (errorMessage) {
      ids.push(MCP_CONFIG_ERROR_ID);
    }
    return ids.length > 0 ? ids.join(' ') : undefined;
  }, [errorMessage, statusMessage]);

  if (!editorAvailable) {
    return (
      <Card>
        <CardContent className="py-6 text-muted-foreground text-sm">
          MCP config editing is unavailable in this runtime.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4" data-testid="mcp-config-editor-panel">
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="space-y-2">
            <label className="font-medium text-sm" htmlFor="mcp-config-path-input-field">
              MCP Config Path
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                className="font-mono text-xs"
                data-testid="mcp-config-path-input"
                id="mcp-config-path-input-field"
                onChange={(event) => setPathDraft(event.target.value)}
                placeholder="/absolute/path/to/mcp.config.json"
                value={pathDraft}
              />
              <div className="flex gap-2">
                {operations.setMcpConfigPath && (
                  <Button
                    data-testid="mcp-config-apply-path"
                    onClick={() => void handleApplyPath()}
                    size="sm"
                    variant="outline"
                  >
                    Apply Path
                  </Button>
                )}
                {operations.openMcpConfig && (
                  <Button
                    data-testid="mcp-config-browse-path"
                    onClick={() => void handleBrowse()}
                    size="sm"
                    variant="outline"
                  >
                    Browse
                  </Button>
                )}
                {operations.resetMcpConfig && (
                  <Button
                    data-testid="mcp-config-reset-path"
                    onClick={() => void handleResetPath()}
                    size="sm"
                    variant="ghost"
                  >
                    Reset
                  </Button>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="font-medium text-sm" htmlFor="mcp-config-editor-field">
                Config Editor (JSONC)
              </label>
              <div className="flex gap-2">
                <Button
                  data-testid="mcp-config-reload"
                  onClick={() => void handleReload()}
                  size="sm"
                  variant="ghost"
                >
                  Reload
                </Button>
                <Button
                  data-testid="mcp-config-save"
                  disabled={loading || !hasUnsavedChanges}
                  onClick={() => void handleSave()}
                  size="sm"
                >
                  Save
                </Button>
              </div>
            </div>
            <textarea
              aria-describedby={editorDescribedBy}
              aria-invalid={errorMessage ? true : undefined}
              className="min-h-[360px] w-full rounded-md border bg-background p-3 font-mono text-xs leading-5"
              data-testid="mcp-config-editor"
              id="mcp-config-editor-field"
              onChange={(event) => setEditorValue(event.target.value)}
              onKeyDown={handleEditorKeyDown}
              spellCheck={false}
              value={editorValue}
            />
            {showReloadConfirm && (
              <div
                className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs"
                data-testid="mcp-config-reload-confirm"
              >
                <span>Discard unsaved MCP config changes and reload from disk?</span>
                <Button
                  data-testid="mcp-config-reload-confirm-discard"
                  onClick={() => void handleConfirmReload()}
                  size="sm"
                  variant="outline"
                >
                  Discard and Reload
                </Button>
                <Button
                  data-testid="mcp-config-reload-confirm-cancel"
                  onClick={handleCancelReload}
                  size="sm"
                  variant="ghost"
                >
                  Keep Editing
                </Button>
              </div>
            )}
            {loading && <div className="text-muted-foreground text-xs">Loading MCP config…</div>}
            {statusMessage && (
              <div
                aria-live="polite"
                className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-emerald-900 text-xs dark:text-emerald-200"
                data-testid="mcp-config-status"
                id={MCP_CONFIG_STATUS_ID}
              >
                {statusMessage}
              </div>
            )}
            {errorMessage && (
              <div
                aria-live="assertive"
                className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-destructive text-xs"
                data-testid="mcp-config-error"
                id={MCP_CONFIG_ERROR_ID}
              >
                {errorMessage}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 p-4">
          <div className="font-medium text-sm">Help</div>
          <div className="text-muted-foreground text-xs">
            Use `stdio` for local commands and `sse` for remote endpoints. Comments are supported in
            this file. Keep placeholder values replaced before enabling servers.
          </div>
          <pre className="overflow-x-auto rounded-md border bg-muted/30 p-3 text-[11px]">
            {`// stdio example
{
  "transport": "stdio",
  "name": "filesystem",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
}

// sse example
{
  "transport": "sse",
  "name": "remote-api",
  "url": "https://your-host.example.com/mcp/sse"
}`}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
