import { createLogger } from '@brainstrike/logging';

const logger = createLogger('ExplicitMcpClient');

export function diagnoseInvalidatedCloseFailure(
  error: unknown,
  transport: 'sse' | 'streamable-http'
): void {
  logger.error('MCP invalidated connection local close failed', { error, transport });
}

export function notifyUnexpectedClose(
  observer: (() => void) | undefined,
  transport: 'sse' | 'stdio' | 'streamable-http'
): void {
  try {
    observer?.();
  } catch (error) {
    logger.error('MCP unexpected-close observer failed', { error, transport });
  }
}
