import { Button, Card, CardContent, Input } from '@brainstrike/ui';
import { type KeyboardEvent, useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { ToolsSettingsOperations } from './types';

interface McpConfigPanelProps {
  onConfigChanged: () => Promise<void>;
  operations: ToolsSettingsOperations;
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

interface McpPanelState {
  editorValue: string;
  errorMessage: string | null;
  /** True once the first document read settled; the editor is withheld until then. */
  initialized: boolean;
  loading: boolean;
  pathDraft: string;
  savedValue: string;
  showReloadConfirm: boolean;
  statusMessage: string | null;
}

type McpPanelAction =
  | { type: 'SET_PATH_DRAFT'; value: string }
  | { type: 'SET_EDITOR_VALUE'; value: string }
  | { type: 'START_LOADING' }
  | {
      type: 'DOCUMENT_LOADED';
      path: string;
      content: string;
      created?: boolean;
      error: string | null;
    }
  | { type: 'LOAD_ERROR'; error: string }
  | { type: 'LOAD_DONE' }
  | { type: 'SET_STATUS'; message: string | null }
  | { type: 'SET_ERROR'; message: string | null }
  | { type: 'CLEAR_MESSAGES' }
  | { type: 'SHOW_RELOAD_CONFIRM' }
  | { type: 'HIDE_RELOAD_CONFIRM' }
  | { type: 'SAVE_SUCCESS'; value: string };

const initialState: McpPanelState = {
  editorValue: '',
  errorMessage: null,
  initialized: false,
  loading: false,
  pathDraft: '',
  savedValue: '',
  showReloadConfirm: false,
  statusMessage: null,
};

function mcpPanelReducer(state: McpPanelState, action: McpPanelAction): McpPanelState {
  switch (action.type) {
    case 'SET_PATH_DRAFT':
      return { ...state, pathDraft: action.value };
    case 'SET_EDITOR_VALUE':
      return { ...state, editorValue: action.value };
    case 'START_LOADING':
      return {
        ...state,
        errorMessage: null,
        loading: true,
        showReloadConfirm: false,
        statusMessage: null,
      };
    case 'DOCUMENT_LOADED':
      return {
        ...state,
        editorValue: action.content,
        errorMessage: action.error,
        initialized: true,
        loading: false,
        pathDraft: action.path,
        savedValue: action.content,
        showReloadConfirm: false,
        statusMessage: action.created
          ? 'Created a new MCP config template with commented examples.'
          : null,
      };
    case 'LOAD_ERROR':
      return {
        ...state,
        errorMessage: action.error,
        initialized: true,
        loading: false,
        showReloadConfirm: false,
        statusMessage: null,
      };
    case 'LOAD_DONE':
      return { ...state, initialized: true, loading: false, showReloadConfirm: false };
    case 'SET_STATUS':
      return { ...state, statusMessage: action.message };
    case 'SET_ERROR':
      return { ...state, errorMessage: action.message };
    case 'CLEAR_MESSAGES':
      return { ...state, errorMessage: null, statusMessage: null };
    case 'SHOW_RELOAD_CONFIRM':
      return { ...state, showReloadConfirm: true };
    case 'HIDE_RELOAD_CONFIRM':
      return { ...state, showReloadConfirm: false };
    case 'SAVE_SUCCESS':
      return {
        ...state,
        savedValue: action.value,
        showReloadConfirm: false,
        statusMessage:
          state.editorValue === action.value
            ? 'MCP config saved.'
            : 'MCP config saved. Newer edits are unsaved.',
      };
    default:
      return state;
  }
}

export function McpConfigPanel({ operations, onConfigChanged }: McpConfigPanelProps) {
  const [state, dispatch] = useReducer(mcpPanelReducer, initialState);
  const {
    pathDraft,
    editorValue,
    savedValue,
    initialized,
    loading,
    statusMessage,
    errorMessage,
    showReloadConfirm,
  } = state;

  const editorAvailable = useMemo(
    () => Boolean(operations.readMcpConfigText && operations.writeMcpConfigText),
    [operations.readMcpConfigText, operations.writeMcpConfigText]
  );
  // Keep fetchAndApplyDocument stable while still using the latest operation callback from props.
  const readMcpConfigTextRef = useRef(operations.readMcpConfigText);
  // A response owns only its document request and the draft it read. Late
  // validation must never replace newer text or mark unsent edits as saved.
  const documentRequestRef = useRef(0);
  const editorRevisionRef = useRef(0);

  useEffect(() => {
    readMcpConfigTextRef.current = operations.readMcpConfigText;
  }, [operations.readMcpConfigText]);

  const hasUnsavedChanges = editorValue !== savedValue;

  const fetchAndApplyDocument = useCallback(async () => {
    const readMcpConfigText = readMcpConfigTextRef.current;
    // Unreachable while `editorAvailable` gates both the mount effect and the
    // render: a runtime without `readMcpConfigText` returns the "unavailable"
    // card and never reaches the `initialized` gate. That is what keeps the
    // gate terminal — every settled outcome below dispatches DOCUMENT_LOADED,
    // LOAD_ERROR (any rejection shape) or LOAD_DONE.
    if (!readMcpConfigText) {
      return;
    }

    const request = ++documentRequestRef.current;
    const editorRevision = editorRevisionRef.current;

    let doc: Awaited<ReturnType<typeof readMcpConfigText>> | null = null;
    let loadError: string | null = null;
    try {
      doc = await readMcpConfigText();
    } catch (error) {
      loadError = error instanceof Error ? error.message : 'Failed to load MCP config';
    }
    if (request !== documentRequestRef.current) {
      return;
    }
    if (editorRevision !== editorRevisionRef.current) {
      dispatch({ type: 'LOAD_DONE' });
      return;
    }
    if (loadError !== null) {
      dispatch({ error: loadError, type: 'LOAD_ERROR' });
      return;
    }
    if (doc === null) {
      dispatch({ type: 'LOAD_DONE' });
    } else {
      dispatch({
        content: doc.content,
        created: doc.created,
        error: doc.error ?? null,
        path: doc.path,
        type: 'DOCUMENT_LOADED',
      });
    }
  }, []);

  const loadDocument = useCallback(async () => {
    dispatch({ type: 'START_LOADING' });
    await fetchAndApplyDocument();
  }, [fetchAndApplyDocument]);

  useEffect(() => {
    if (!editorAvailable) {
      return;
    }
    void fetchAndApplyDocument();
    return () => {
      documentRequestRef.current += 1;
    };
  }, [editorAvailable, fetchAndApplyDocument]);

  const handleApplyPath = useCallback(async () => {
    if (!operations.setMcpConfigPath) {
      return;
    }

    const nextPath = pathDraft.trim();
    const resolvedPath = nextPath.length > 0 ? nextPath : null;
    if (nextPath.length > 0 && !isAbsoluteFilePath(nextPath)) {
      dispatch({
        message: 'Please provide an absolute path to the MCP config file.',
        type: 'SET_ERROR',
      });
      return;
    }
    dispatch({ type: 'CLEAR_MESSAGES' });
    try {
      await operations.setMcpConfigPath(resolvedPath);
      await Promise.all([onConfigChanged(), loadDocument()]);
      dispatch({ message: 'MCP config path updated.', type: 'SET_STATUS' });
    } catch (error) {
      dispatch({
        message: error instanceof Error ? error.message : 'Failed to update MCP config path',
        type: 'SET_ERROR',
      });
    }
  }, [loadDocument, onConfigChanged, operations, pathDraft]);

  const handleBrowse = useCallback(async () => {
    if (!operations.openMcpConfig) {
      return;
    }

    try {
      dispatch({ type: 'CLEAR_MESSAGES' });
      await operations.openMcpConfig();
      await Promise.all([onConfigChanged(), loadDocument()]);
    } catch (error) {
      dispatch({
        message: error instanceof Error ? error.message : 'Failed to open MCP config picker',
        type: 'SET_ERROR',
      });
    }
  }, [loadDocument, onConfigChanged, operations]);

  const handleResetPath = useCallback(async () => {
    if (!operations.resetMcpConfig) {
      return;
    }

    try {
      dispatch({ type: 'CLEAR_MESSAGES' });
      await operations.resetMcpConfig();
      await Promise.all([onConfigChanged(), loadDocument()]);
      dispatch({ message: 'MCP config path reset to default.', type: 'SET_STATUS' });
    } catch (error) {
      dispatch({
        message: error instanceof Error ? error.message : 'Failed to reset MCP config path',
        type: 'SET_ERROR',
      });
    }
  }, [loadDocument, onConfigChanged, operations]);

  const handleSave = useCallback(async () => {
    if (!operations.writeMcpConfigText) {
      return;
    }

    const request = ++documentRequestRef.current;
    const editorRevision = editorRevisionRef.current;
    const ownsFeedback = (): boolean =>
      request === documentRequestRef.current && editorRevision === editorRevisionRef.current;

    try {
      dispatch({ type: 'CLEAR_MESSAGES' });
      const result = await operations.writeMcpConfigText(editorValue);
      if (!result.success) {
        if (ownsFeedback()) {
          dispatch({ message: result.error, type: 'SET_ERROR' });
        }
        return;
      }
      if (request === documentRequestRef.current) {
        dispatch({ type: 'SAVE_SUCCESS', value: editorValue });
      }
      await onConfigChanged();
    } catch (error) {
      if (ownsFeedback()) {
        dispatch({
          message: error instanceof Error ? error.message : 'Failed to save MCP config',
          type: 'SET_ERROR',
        });
      }
    }
  }, [editorValue, onConfigChanged, operations]);

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
      dispatch({ type: 'SHOW_RELOAD_CONFIRM' });
      return;
    }

    await loadDocument();
  }, [hasUnsavedChanges, loadDocument]);

  const handleConfirmReload = useCallback(async () => {
    dispatch({ type: 'HIDE_RELOAD_CONFIRM' });
    await loadDocument();
  }, [loadDocument]);

  const handleCancelReload = useCallback(() => {
    dispatch({ type: 'HIDE_RELOAD_CONFIRM' });
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
      <McpPathCard
        onApplyPath={() => void handleApplyPath()}
        onBrowse={operations.openMcpConfig ? () => void handleBrowse() : undefined}
        onPathChange={(value) => dispatch({ type: 'SET_PATH_DRAFT', value })}
        onResetPath={operations.resetMcpConfig ? () => void handleResetPath() : undefined}
        pathDraft={pathDraft}
        showApplyPath={Boolean(operations.setMcpConfigPath)}
      />
      {initialized ? (
        <McpEditorCard
          editorDescribedBy={editorDescribedBy}
          editorValue={editorValue}
          errorMessage={errorMessage}
          hasUnsavedChanges={hasUnsavedChanges}
          loading={loading}
          onCancelReload={handleCancelReload}
          onConfirmReload={() => void handleConfirmReload()}
          onEditorChange={(value) => {
            editorRevisionRef.current += 1;
            dispatch({ type: 'SET_EDITOR_VALUE', value });
          }}
          onEditorKeyDown={handleEditorKeyDown}
          onReload={() => void handleReload()}
          onSave={() => void handleSave()}
          showReloadConfirm={showReloadConfirm}
          statusMessage={statusMessage}
        />
      ) : (
        <Card>
          <CardContent className="py-6 text-muted-foreground text-sm">
            Loading MCP config…
          </CardContent>
        </Card>
      )}
      <McpHelpCard />
    </div>
  );
}

interface McpPathCardProps {
  onApplyPath: () => void;
  onBrowse?: (() => void) | undefined;
  onPathChange: (value: string) => void;
  onResetPath?: (() => void) | undefined;
  pathDraft: string;
  showApplyPath: boolean;
}

function McpPathCard({
  pathDraft,
  onPathChange,
  showApplyPath,
  onApplyPath,
  onBrowse,
  onResetPath,
}: McpPathCardProps) {
  return (
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
              onChange={(event) => onPathChange(event.target.value)}
              placeholder="/absolute/path/to/mcp.config.json"
              value={pathDraft}
            />
            <div className="flex gap-2">
              {showApplyPath && (
                <Button
                  data-testid="mcp-config-apply-path"
                  onClick={onApplyPath}
                  size="sm"
                  variant="outline"
                >
                  Apply Path
                </Button>
              )}
              {onBrowse && (
                <Button
                  data-testid="mcp-config-browse-path"
                  onClick={onBrowse}
                  size="sm"
                  variant="outline"
                >
                  Browse
                </Button>
              )}
              {onResetPath && (
                <Button
                  data-testid="mcp-config-reset-path"
                  onClick={onResetPath}
                  size="sm"
                  variant="ghost"
                >
                  Reset
                </Button>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

interface McpEditorCardProps {
  editorDescribedBy: string | undefined;
  editorValue: string;
  errorMessage: string | null;
  hasUnsavedChanges: boolean;
  loading: boolean;
  onCancelReload: () => void;
  onConfirmReload: () => void;
  onEditorChange: (value: string) => void;
  onEditorKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onReload: () => void;
  onSave: () => void;
  showReloadConfirm: boolean;
  statusMessage: string | null;
}

function McpEditorCard({
  editorValue,
  editorDescribedBy,
  errorMessage,
  statusMessage,
  loading,
  hasUnsavedChanges,
  showReloadConfirm,
  onEditorChange,
  onEditorKeyDown,
  onSave,
  onReload,
  onConfirmReload,
  onCancelReload,
}: McpEditorCardProps) {
  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="font-medium text-sm" htmlFor="mcp-config-editor-field">
            Config Editor (JSONC)
          </label>
          <div className="flex gap-2">
            <Button data-testid="mcp-config-reload" onClick={onReload} size="sm" variant="ghost">
              Reload
            </Button>
            <Button
              data-testid="mcp-config-save"
              disabled={loading || !hasUnsavedChanges}
              onClick={onSave}
              size="sm"
            >
              Save
            </Button>
          </div>
        </div>
        <textarea
          aria-describedby={editorDescribedBy}
          aria-invalid={errorMessage ? true : undefined}
          className="max-h-[600px] min-h-[360px] w-full resize-y overflow-y-auto rounded-md border bg-background p-3 font-mono text-xs leading-5"
          data-testid="mcp-config-editor"
          id="mcp-config-editor-field"
          onChange={(event) => onEditorChange(event.target.value)}
          onKeyDown={onEditorKeyDown}
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
              onClick={onConfirmReload}
              size="sm"
              variant="outline"
            >
              Discard and Reload
            </Button>
            <Button
              data-testid="mcp-config-reload-confirm-cancel"
              onClick={onCancelReload}
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
      </CardContent>
    </Card>
  );
}

function McpHelpCard() {
  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <div className="font-medium text-sm">Help</div>
        <div className="text-muted-foreground text-xs">
          Use `streamable-http` for new remote endpoints, `stdio` for local commands, and `sse` only
          for legacy HTTP+SSE servers. Comments are supported in this file. Keep placeholder values
          replaced before enabling servers.
        </div>
        <pre className="overflow-x-auto rounded-md border bg-muted/30 p-3 text-[11px]">
          {`// stdio example
{
  "transport": "stdio",
  "name": "filesystem",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
}

// Streamable HTTP example (recommended)
{
  "transport": "streamable-http",
  "name": "remote-api",
  "url": "https://your-host.example.com/mcp"
}

// Legacy SSE example
{
  "transport": "sse",
  "name": "legacy-remote-api",
  "url": "https://your-host.example.com/mcp/sse"
}`}
        </pre>
      </CardContent>
    </Card>
  );
}
