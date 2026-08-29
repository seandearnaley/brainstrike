import {
  isMcpLabCorrelationId,
  isServerToClientOnlyMethod,
  type McpLabProtocolMethod,
  type McpLabProtocolPhase,
  protocolPhaseForMethod,
} from './faults.js';

export const HTTP_PROTOCOL_COORDINATE_PHASES = [
  'initialization',
  'operation',
  'subscription',
] as const satisfies readonly McpLabProtocolPhase[];

export function oauthFaultMethod(pathname: string): McpLabProtocolMethod | undefined {
  switch (pathname) {
    case '/.well-known/oauth-protected-resource/mcp':
      return 'oauth/protected-resource';
    case '/.well-known/oauth-authorization-server':
      return 'oauth/authorization-server';
    case '/authorize':
      return 'oauth/authorize';
    case '/callback':
      return 'oauth/callback';
    case '/register':
      return 'oauth/register';
    case '/revoke':
      return 'oauth/revoke';
    case '/token':
      return 'oauth/token';
    default:
      return;
  }
}

function protocolCoordinateForMethod(
  method: string | undefined
): { readonly method: McpLabProtocolMethod; readonly phase: McpLabProtocolPhase } | undefined {
  if (!method) {
    return;
  }
  const phase = protocolPhaseForMethod(method);
  return phase &&
    (HTTP_PROTOCOL_COORDINATE_PHASES as readonly McpLabProtocolPhase[]).includes(phase)
    ? { method: method as McpLabProtocolMethod, phase }
    : undefined;
}

function jsonRpcMethod(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return;
  }
  const record = body as Record<string, unknown>;
  const method = record['method'];
  if (typeof method !== 'string') {
    return;
  }
  if (record['jsonrpc'] !== '2.0') {
    throw new Error('Invalid MCP lab request: JSON-RPC body must declare jsonrpc 2.0');
  }
  const id = record['id'];
  const isNotification = method.startsWith('notifications/');
  if (
    (isNotification && Object.hasOwn(record, 'id')) ||
    (!isNotification && typeof id !== 'string' && typeof id !== 'number')
  ) {
    throw new Error('Invalid MCP lab request: JSON-RPC request identity is invalid');
  }
  if (isServerToClientOnlyMethod(method)) {
    throw new Error('Invalid MCP lab request: JSON-RPC method has the wrong direction');
  }
  return method;
}

export async function protocolCoordinate(
  request: Request
): Promise<
  { readonly method: McpLabProtocolMethod; readonly phase: McpLabProtocolPhase } | undefined
> {
  const oauth = oauthFaultMethod(new URL(request.url).pathname);
  if (oauth) {
    return { method: oauth, phase: 'authorization' };
  }
  const headerMethod = request.headers.get('mcp-method') ?? undefined;
  if (request.method !== 'POST') {
    return;
  }
  try {
    const body: unknown = await request.clone().json();
    const bodyMethod = jsonRpcMethod(body);
    if (headerMethod && headerMethod !== bodyMethod) {
      throw new Error('Invalid MCP lab request: mcp-method header must match the JSON-RPC body');
    }
    return protocolCoordinateForMethod(bodyMethod);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid MCP lab request:')) {
      throw error;
    }
    return;
  }
}

export function correlationIdForRequest(request: Request, nextCorrelation: () => string): string {
  const supplied = request.headers.get('x-mcp-lab-correlation-id');
  if (supplied === null) {
    return nextCorrelation();
  }
  if (!isMcpLabCorrelationId(supplied)) {
    throw new Error('Invalid MCP lab correlation id');
  }
  return supplied;
}
