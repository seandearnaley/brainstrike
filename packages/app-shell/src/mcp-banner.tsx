import { Badge } from '@brainstrike/ui';
import { useEffect, useReducer } from 'react';

interface McpStatus {
  exists: boolean;
  servers: Array<{ name: string; transport: 'stdio' | 'sse' }>;
}

interface McpState {
  error: string | null;
  status: McpStatus | null;
}

type McpAction =
  | { type: 'RESET' }
  | { type: 'SUCCESS'; status: McpStatus }
  | { type: 'ERROR'; error: string };

interface McpConfigResult {
  error?: string;
  exists: boolean;
  servers?: McpStatus['servers'];
}

const initialMcpState: McpState = { error: null, status: null };

function mcpReducer(state: McpState, action: McpAction): McpState {
  switch (action.type) {
    case 'RESET':
      return { error: null, status: null };
    case 'SUCCESS':
      return { error: null, status: action.status };
    case 'ERROR':
      return { error: action.error, status: null };
    default:
      return state;
  }
}

function actionFromConfig(result: McpConfigResult | undefined): McpAction {
  if (!result) {
    return { type: 'RESET' };
  }

  if (result.error !== undefined) {
    return { error: result.error, type: 'ERROR' };
  }

  return {
    status: {
      exists: Boolean(result.exists),
      servers: result.servers ?? [],
    },
    type: 'SUCCESS',
  };
}

export function McpBanner() {
  const [{ status, error }, dispatch] = useReducer(mcpReducer, initialMcpState);

  useEffect(() => {
    let mounted = true;
    let latestRequest: object | null = null;

    async function run() {
      const currentRequest = {};
      latestRequest = currentRequest;
      try {
        const res = await window.mcp?.getConfig?.();
        if (!mounted || currentRequest !== latestRequest) {
          return;
        }

        dispatch(actionFromConfig(res));
      } catch (e) {
        if (!mounted || currentRequest !== latestRequest) {
          return;
        }
        dispatch({ error: e instanceof Error ? e.message : String(e), type: 'ERROR' });
      }
    }

    void run();
    const unsubscribe = window.mcp?.onToolsUpdated?.(() => {
      void run();
    });

    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  if (status === null && error === null) {
    return null;
  }

  const exists = Boolean(status?.exists);
  const servers = status?.servers ?? [];

  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="opacity-70">MCP:</span>
      {error === null ? (
        exists ? (
          <Badge variant="secondary">loaded</Badge>
        ) : (
          <Badge variant="destructive">missing</Badge>
        )
      ) : (
        <Badge variant="destructive">error</Badge>
      )}
      {error === null && servers.length > 0 && (
        <span className="opacity-70">
          {servers.length} server{servers.length > 1 ? 's' : ''}
        </span>
      )}
      {error !== null && <span className="text-destructive">{error}</span>}
    </div>
  );
}

export default McpBanner;
