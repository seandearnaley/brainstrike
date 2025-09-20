import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@brainstrike/ui';
import { useEffect, useState } from 'react';

type Loaded = {
  path: string;
  exists: boolean;
  servers?: Array<{ name: string; transport: 'stdio' | 'sse' }>;
};

async function fetchMcpConfig(): Promise<{ status: Loaded | null; error: string | null }> {
  try {
    const res = await window.mcp?.getConfig?.();
    if (!res || typeof res !== 'object') {
      return { status: null, error: 'MCP preload API unavailable.' };
    }

    const path = String(res.path ?? '');
    const exists = Boolean(res.exists);
    const servers = (res.servers ?? []) as Loaded['servers'];
    const status = { path, exists, servers };
    const error = !exists
      ? 'No valid MCP config found. Using defaults without external tools.'
      : null;

    return { status, error };
  } catch (e) {
    return {
      status: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function McpConfigStatus() {
  const [status, setStatus] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    void fetchMcpConfig().then((result) => {
      if (mounted) {
        setStatus(result.status);
        setError(result.error);
      }
    });

    return () => {
      mounted = false;
    };
  }, []);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">MCP Tools</CardTitle>
        <CardDescription className="text-xs">Configure external tool servers</CardDescription>
      </CardHeader>
      <CardContent className="text-xs space-y-2">
        {status && (
          <div className="flex items-center gap-2">
            <span>Config:</span>
            <code className="px-1 py-0.5 bg-muted rounded text-[10px]">
              {status.path || 'unknown'}
            </code>
            {status.exists ? (
              <Badge variant="secondary">loaded</Badge>
            ) : (
              <Badge variant="destructive">missing/invalid</Badge>
            )}
          </div>
        )}
        {status?.servers && status.servers.length > 0 && (
          <div>
            <div className="mb-1">Servers:</div>
            <div className="flex flex-wrap gap-1">
              {status.servers.map((s, i) => (
                <Badge key={`${s.name}-${i}`} variant="outline">
                  {s.name} · {s.transport}
                </Badge>
              ))}
            </div>
          </div>
        )}
        {error && <div className="text-[11px] text-destructive">{error}</div>}
      </CardContent>
    </Card>
  );
}

export default McpConfigStatus;
