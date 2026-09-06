import {
  isJSONRPCNotification,
  isJSONRPCRequest,
  type JSONRPCMessage,
  type RequestId,
  specTypeSchemas,
} from '@modelcontextprotocol/client';
import { classifyInboundRequest } from '@modelcontextprotocol/server';
import {
  isExecutableProtocolMethod,
  type McpLabProtocolEra,
  type McpLabProtocolMethod,
  type McpLabProtocolPhase,
  protocolPhaseForMethod,
} from './faults.js';

export interface McpLabStdioCoordinate {
  readonly method: McpLabProtocolMethod;
  readonly phase: McpLabProtocolPhase;
  readonly requestId?: RequestId;
}

export async function stdioProtocolCoordinate(
  message: JSONRPCMessage,
  era: McpLabProtocolEra
): Promise<McpLabStdioCoordinate | undefined> {
  if (!(isJSONRPCRequest(message) || isJSONRPCNotification(message))) {
    return;
  }
  const requestId = isJSONRPCRequest(message) ? message.id : undefined;
  const schema =
    requestId === undefined ? specTypeSchemas.ClientNotification : specTypeSchemas.ClientRequest;
  const validation = await schema['~standard'].validate(message);
  if (validation.issues !== undefined) {
    return;
  }
  const classification = classifyInboundRequest({
    body: message,
    httpMethod: 'POST',
    ...(requestId === undefined ? {} : { mcpMethodHeader: message.method }),
  });
  if (classification.kind !== era || !isExecutableProtocolMethod(message.method, era)) {
    return;
  }
  const phase = protocolPhaseForMethod(message.method);
  if (!phase) {
    return;
  }
  return Object.freeze({
    method: message.method,
    phase,
    ...(requestId === undefined ? {} : { requestId }),
  });
}

export function stdioResponseId(message: JSONRPCMessage): RequestId | undefined {
  if (!('id' in message) || 'method' in message) {
    return;
  }
  return typeof message.id === 'string' || typeof message.id === 'number' ? message.id : undefined;
}
