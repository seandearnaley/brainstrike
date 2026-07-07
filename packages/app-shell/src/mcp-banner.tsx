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

const initialMcpState: McpState = { error: null, status: null };

function mcpReducer(state: McpState, action: McpAction): McpState {
  switch (action.type) {
    case 'RESET':
      return { error: null, status: null };
    case 'SUCCESS':
      return { error: null, status: action.status };
    case 'ERROR':
      return { error: action.error, status: state.status };
    default:
      return state;
  }
}

export function McpBanner() {
  const [{ status, error }, dispatch] = useReducer(mcpReducer, initialMcpState);

  useEffect(() => {
    let mounted = true;

    async function fetchMcpConfig() {
      const res = await window.mcp?.getConfig?.();
      if (!mounted) {
        return;
      }

      if (!res) {
        dispatch({ type: 'RESET' });
        return;
      }

      dispatch({
        status: {
          exists: Boolean(res.exists),
          servers: (res.servers ?? []) as McpStatus['servers'],
        },
        type: 'SUCCESS',
      });
    }

    async function run() {
      try {
        await fetchMcpConfig();
      } catch (e) {
        if (!mounted) {
          return;
        }
        dispatch({ error: e instanceof Error ? e.message : String(e), type: 'ERROR' });
      }
    }

    void run();
    return () => {
      mounted = false;
    };
  }, []);

  if (!(status || error)) {
    return null;
  }

  const exists = Boolean(status?.exists);
  const servers = status?.servers ?? [];

  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="opacity-70">MCP:</span>
      {exists ? (
        <Badge variant="secondary">loaded</Badge>
      ) : (
        <Badge variant="destructive">missing</Badge>
      )}
      {servers.length > 0 && (
        <span className="opacity-70">
          {servers.length} server{servers.length > 1 ? 's' : ''}
        </span>
      )}
      {error && <span className="text-destructive">{error}</span>}
    </div>
  );
}

export default McpBanner;
