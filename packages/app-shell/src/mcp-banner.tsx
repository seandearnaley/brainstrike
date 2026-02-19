import { Badge } from '@brainstrike/ui';
import { useEffect, useReducer } from 'react';

interface McpStatus {
  exists: boolean;
  servers: Array<{ name: string; transport: 'stdio' | 'sse' }>;
}

interface McpState {
  status: McpStatus | null;
  error: string | null;
}

type McpAction =
  | { type: 'RESET' }
  | { type: 'SUCCESS'; status: McpStatus }
  | { type: 'ERROR'; error: string };

const initialMcpState: McpState = { status: null, error: null };

function mcpReducer(state: McpState, action: McpAction): McpState {
  switch (action.type) {
    case 'RESET':
      return { status: null, error: null };
    case 'SUCCESS':
      return { status: action.status, error: null };
    case 'ERROR':
      return { status: state.status, error: action.error };
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
        type: 'SUCCESS',
        status: {
          exists: Boolean(res.exists),
          servers: (res.servers ?? []) as McpStatus['servers'],
        },
      });
    }

    async function run() {
      try {
        await fetchMcpConfig();
      } catch (e) {
        if (!mounted) {
          return;
        }
        dispatch({ type: 'ERROR', error: e instanceof Error ? e.message : String(e) });
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
