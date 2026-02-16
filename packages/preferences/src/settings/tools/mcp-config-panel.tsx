import { Button, Card, CardContent, Input } from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ToolsSettingsOperations } from './types';

interface McpConfigPanelProps {
  operations: ToolsSettingsOperations;
  onConfigChanged: () => Promise<void>;
}

const WINDOWS_DRIVE_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/u;
const WINDOWS_UNC_PATH = /^\\\\/u;

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

  const editorAvailable = useMemo(
    () => Boolean(operations.readMcpConfigText && operations.writeMcpConfigText),
    [operations.readMcpConfigText, operations.writeMcpConfigText]
  );
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
      setStatusMessage('MCP config saved.');
      await onConfigChanged();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to save MCP config');
    }
  }, [editorValue, onConfigChanged, operations.writeMcpConfigText]);

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
            <div className="font-medium text-sm">MCP Config Path</div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                className="font-mono text-xs"
                data-testid="mcp-config-path-input"
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
              <div className="font-medium text-sm">Config Editor (JSONC)</div>
              <div className="flex gap-2">
                <Button
                  data-testid="mcp-config-reload"
                  onClick={() => void loadDocument()}
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
              className="min-h-[360px] w-full rounded-md border bg-background p-3 font-mono text-xs leading-5"
              data-testid="mcp-config-editor"
              onChange={(event) => setEditorValue(event.target.value)}
              spellCheck={false}
              value={editorValue}
            />
            {loading && <div className="text-muted-foreground text-xs">Loading MCP config…</div>}
            {statusMessage && (
              <div
                className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-emerald-900 text-xs dark:text-emerald-200"
                data-testid="mcp-config-status"
              >
                {statusMessage}
              </div>
            )}
            {errorMessage && (
              <div
                className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-destructive text-xs"
                data-testid="mcp-config-error"
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

export default McpConfigPanel;
