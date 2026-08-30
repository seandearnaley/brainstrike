import { createLogger } from '@brainstrike/logging';

const logger = createLogger('ExplicitMcpClient');

export function diagnoseInvalidatedCloseFailure(
  error: unknown,
  transport: 'sse' | 'streamable-http'
): void {
  logger.error('MCP invalidated connection local close failed', { error, transport });
}

export function notifyUnexpectedClose(
  observer: (() => void | Promise<void>) | undefined,
  transport: 'sse' | 'stdio' | 'streamable-http'
): void {
  try {
    const notification = observer?.();
    if (notification) {
      void Promise.resolve(notification).catch((error: unknown) => {
        logger.error('MCP unexpected-close observer failed', { error, transport });
      });
    }
  } catch (error) {
    logger.error('MCP unexpected-close observer failed', { error, transport });
  }
}
