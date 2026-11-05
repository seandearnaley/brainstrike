import type { MessagePort } from 'node:worker_threads';
import {
  createMessageConnection,
  type MessageConnection,
  PortMessageReader,
  PortMessageWriter,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import { jsonRpcLogger } from './boundary-wire.ts';

const logger = jsonRpcLogger('AgentHostRpc');

export function nodePortConnection(port: MessagePort): MessageConnection {
  return createMessageConnection(new PortMessageReader(port), new PortMessageWriter(port), logger);
}
export function stdioConnection(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream
): MessageConnection {
  return createMessageConnection(
    new StreamMessageReader(input),
    new StreamMessageWriter(output),
    logger
  );
}
