import { createLogger } from '@brainstrike/utils';
import { createQueueTelemetryCollector, type QueueTelemetryCollectorOptions } from './collector';

const logger = createLogger('QueueTelemetryCollectorCLI');

function parsePort(portValue: string | undefined, fallback: number): number {
  if (!portValue) {
    return fallback;
  }
  const parsed = Number.parseInt(portValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`Invalid QUEUE_TELEMETRY_PORT value: ${portValue}`);
  }
  return parsed;
}

function parseMaxBody(bytesValue: string | undefined, fallback: number): number {
  if (!bytesValue) {
    return fallback;
  }
  const parsed = Number.parseInt(bytesValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid QUEUE_TELEMETRY_MAX_BODY_BYTES value: ${bytesValue}`);
  }
  return parsed;
}

export async function runQueueTelemetryCollectorCli(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const host = env['QUEUE_TELEMETRY_HOST'] ?? '0.0.0.0';
  const port = parsePort(env['QUEUE_TELEMETRY_PORT'], 4130);
  const path = env['QUEUE_TELEMETRY_PATH'] ?? '/queue-telemetry';
  const apiKey = env['QUEUE_TELEMETRY_API_KEY'];
  const maxBodyBytes = parseMaxBody(env['QUEUE_TELEMETRY_MAX_BODY_BYTES'], 256_000);

  const collectorOptions: QueueTelemetryCollectorOptions = {
    host,
    maxBodyBytes,
    path,
    port,
    ...(apiKey ? { apiKey } : {}),
  };

  const collector = createQueueTelemetryCollector(collectorOptions);

  await collector.start();
  const endpoint = collector.getEndpoint();
  logger.info('Queue telemetry collector ready', {
    apiKeyProvided: Boolean(apiKey),
    endpoint,
    maxBodyBytes,
  });

  const shutdown = async () => {
    logger.info('Shutting down queue telemetry collector');
    await collector.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runQueueTelemetryCollectorCli().catch((error) => {
    logger.error('Queue telemetry collector failed to start', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}
