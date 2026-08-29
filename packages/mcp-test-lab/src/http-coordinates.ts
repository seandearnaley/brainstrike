import {
  classifyInboundRequest,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJsonContentType,
  specTypeSchemas,
} from '@modelcontextprotocol/server';
import {
  isExecutableProtocolMethod,
  type McpLabProtocolEra,
  type McpLabProtocolMethod,
  type McpLabProtocolPhase,
  protocolPhaseForMethod,
} from './faults.js';

export const HTTP_PROTOCOL_COORDINATE_PHASES = [
  'initialization',
  'operation',
  'subscription',
] as const satisfies readonly McpLabProtocolPhase[];

export interface McpLabHttpProtocolCoordinate {
  readonly method: McpLabProtocolMethod;
  readonly parsedBody: unknown;
  readonly phase: McpLabProtocolPhase;
}

export function oauthFaultMethod(request: Request): McpLabProtocolMethod | undefined {
  const url = new URL(request.url);
  if (url.hash !== '') {
    return;
  }
  const route = `${request.method} ${url.pathname}`;
  if (route !== 'GET /authorize' && url.search !== '') {
    return;
  }
  switch (route) {
    case 'GET /.well-known/oauth-protected-resource/mcp':
      return 'oauth/protected-resource';
    case 'GET /.well-known/oauth-authorization-server':
      return 'oauth/authorization-server';
    case 'POST /register':
      return 'oauth/register';
    case 'GET /authorize':
      return 'oauth/authorize';
    case 'POST /token':
      return 'oauth/token';
    default:
      return;
  }
}

function protocolCoordinateForMethod(
  method: string,
  era: McpLabProtocolEra,
  parsedBody: unknown
): McpLabHttpProtocolCoordinate | undefined {
  if (!isExecutableProtocolMethod(method, era)) {
    return;
  }
  const phase = protocolPhaseForMethod(method);
  return phase &&
    (HTTP_PROTOCOL_COORDINATE_PHASES as readonly McpLabProtocolPhase[]).includes(phase)
    ? Object.freeze({ method, parsedBody, phase })
    : undefined;
}

async function isSdkClientMessage(body: unknown): Promise<boolean> {
  const schema = isJSONRPCRequest(body)
    ? specTypeSchemas.ClientRequest
    : isJSONRPCNotification(body)
      ? specTypeSchemas.ClientNotification
      : undefined;
  if (!schema) {
    return false;
  }
  const result = await schema['~standard'].validate(body);
  return result.issues === undefined;
}

function decodeMcpName(value: string): string | undefined {
  // Mirrors the pinned SDK's private decodeMcpParamValue implementation used by
  // validateStandardRequestHeaders. The strict base64 round-trip rejects values
  // that Node's permissive decoder would otherwise coerce.
  if (!(value.startsWith('=?base64?') && value.endsWith('?='))) {
    return value;
  }
  const encoded = value.slice(9, -2);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    return;
  }
  try {
    const decoded = Buffer.from(encoded, 'base64');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
    return decoded.toString('base64') === encoded ? text : undefined;
  } catch {
    return;
  }
}

function hasValidModernHeaders(request: Request, body: unknown): boolean {
  if (!isJSONRPCRequest(body)) {
    return true;
  }
  if (request.headers.get('mcp-method') !== body.method) {
    return false;
  }
  if (body.method !== 'tools/call') {
    return true;
  }
  const params = body.params;
  const name =
    typeof params === 'object' && params !== null && !Array.isArray(params)
      ? (params as Readonly<Record<string, unknown>>)['name']
      : undefined;
  const header = request.headers.get('mcp-name');
  return typeof name === 'string' && header !== null && decodeMcpName(header) === name;
}

export async function protocolCoordinate(
  request: Request,
  era: McpLabProtocolEra
): Promise<McpLabHttpProtocolCoordinate | undefined> {
  const url = new URL(request.url);
  if (
    request.method !== 'POST' ||
    url.pathname !== '/mcp' ||
    url.search !== '' ||
    url.hash !== '' ||
    !isJsonContentType(request.headers.get('content-type'))
  ) {
    return;
  }
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return;
  }
  if (!(await isSdkClientMessage(body))) {
    return;
  }
  const mcpMethodHeader = request.headers.get('mcp-method') ?? undefined;
  const mcpNameHeader = request.headers.get('mcp-name') ?? undefined;
  const protocolVersionHeader = request.headers.get('mcp-protocol-version') ?? undefined;
  const outcome = classifyInboundRequest({
    body,
    httpMethod: request.method,
    ...(mcpMethodHeader === undefined ? {} : { mcpMethodHeader }),
    ...(mcpNameHeader === undefined ? {} : { mcpNameHeader }),
    ...(protocolVersionHeader === undefined ? {} : { protocolVersionHeader }),
  });
  if (outcome.kind === 'reject' || outcome.kind !== era) {
    return;
  }
  if (outcome.kind === 'modern' && !hasValidModernHeaders(request, body)) {
    return;
  }
  const method =
    outcome.kind === 'modern'
      ? outcome.message.method
      : isJSONRPCRequest(body) || isJSONRPCNotification(body)
        ? body.method
        : undefined;
  return method ? protocolCoordinateForMethod(method, era, body) : undefined;
}
