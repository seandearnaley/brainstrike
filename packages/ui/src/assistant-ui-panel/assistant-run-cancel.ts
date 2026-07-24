export function readPreparedRunId(
  preparedData: Record<string, unknown> | undefined
): string | undefined {
  const memory = preparedData?.['memory'];
  if (!(memory && typeof memory === 'object' && !Array.isArray(memory))) {
    return;
  }
  const runId = (memory as Record<string, unknown>)['runId'];
  return typeof runId === 'string' && runId.trim().length > 0 ? runId : undefined;
}

export async function requestAssistantRunCancel({
  authHeaders,
  baseUrl,
  runId,
}: {
  authHeaders?: (() => Promise<Record<string, string>>) | undefined;
  baseUrl: string;
  runId: string;
}): Promise<void> {
  const headersValue = authHeaders ? await authHeaders() : undefined;
  const headers = new Headers(headersValue);
  headers.set('Content-Type', 'application/json');
  const response = await fetch(new URL('/assistant/cancel', baseUrl), {
    body: JSON.stringify({ runId }),
    headers,
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`Assistant cancel request failed with status ${response.status}.`);
  }
}
