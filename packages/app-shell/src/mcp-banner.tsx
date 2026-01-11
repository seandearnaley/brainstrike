import { Badge } from '@brainstrike/ui';
import { useEffect, useState } from 'react';

interface McpStatus {
  exists: boolean;
  servers: Array<{ name: string; transport: 'stdio' | 'sse' }>;
}

export function McpBanner() {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/plugin: Async data fetching on mount - standard pattern for loading MCP config
  useEffect(() => {
    let mounted = true;

    async function fetchMcpConfig() {
      const res = await window.mcp?.getConfig?.();
      if (!mounted) {
        return;
      }

      if (!res) {
        setStatus(null);
        setError(null);
        return;
      }

      setStatus({
        exists: Boolean(res.exists),
        servers: (res.servers ?? []) as McpStatus['servers'],
      });
      setError(null);
    }

    async function run() {
      try {
        await fetchMcpConfig();
      } catch (e) {
        if (!mounted) {
          return;
        }
        setError(e instanceof Error ? e.message : String(e));
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
