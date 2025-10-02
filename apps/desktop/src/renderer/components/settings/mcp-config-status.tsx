import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  useToast,
} from '@brainstrike/ui';
import { useCallback, useEffect, useState } from 'react';

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
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    const result = await fetchMcpConfig();
    setStatus(result.status);
    setError(result.error);
  }, []);

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

  const handleSelectPath = useCallback(async () => {
    setBusy(true);
    try {
      const selectedPath = await window.mcp?.selectPath?.();
      if (selectedPath) {
        const result = await window.mcp?.setPath?.(selectedPath);
        if (result?.success) {
          toast({
            title: 'Config path updated',
            description: `Now using: ${result.path}`,
          });
          await refresh();
        }
      }
    } catch (e) {
      toast({
        title: 'Failed to update config path',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  }, [refresh, toast]);

  const handleResetPath = useCallback(async () => {
    setBusy(true);
    try {
      const result = await window.mcp?.setPath?.(null);
      if (result?.success) {
        toast({
          title: 'Config path reset',
          description: `Using default: ${result.path}`,
        });
        await refresh();
      }
    } catch (e) {
      toast({
        title: 'Failed to reset config path',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  }, [refresh, toast]);

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
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={handleSelectPath}
            data-testid="select-mcp-config-path"
          >
            Change Config File
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={handleResetPath}
            data-testid="reset-mcp-config-path"
          >
            Reset to Default
          </Button>
        </div>
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
