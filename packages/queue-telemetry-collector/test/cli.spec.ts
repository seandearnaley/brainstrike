import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cli from '../src/cli';
import * as collectorModule from '../src/collector';

const cliMocks = vi.hoisted(() => {
  const start = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue(undefined);
  const getEndpoint = vi.fn().mockReturnValue('http://localhost:4130/queue-telemetry');
  return { getEndpoint, start, stop };
});

// Mock dependencies
vi.mock('../src/collector', () => ({
  createQueueTelemetryCollector: vi.fn(() => ({
    getEndpoint: cliMocks.getEndpoint,
    start: cliMocks.start,
    stop: cliMocks.stop,
  })),
}));

vi.mock('@brainstrike/utils', () => ({
  createLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
  }),
}));

describe('CLI', () => {
  const originalEnv = process.env;
  const originalArgv = process.argv;
  const originalExit = process.exit;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.argv = [...originalArgv];
    process.exit = vi.fn() as any;
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    process.argv = originalArgv;
    process.exit = originalExit;
    vi.resetModules();
  });

  it('starts collector with default options', async () => {
    await cli.runQueueTelemetryCollectorCli({});

    expect(collectorModule.createQueueTelemetryCollector).toHaveBeenCalledWith(
      expect.objectContaining({
        host: '0.0.0.0',
        maxBodyBytes: 256_000,
        path: '/queue-telemetry',
        port: 4130,
      })
    );
  });

  it('starts collector with env var options', async () => {
    await cli.runQueueTelemetryCollectorCli({
      QUEUE_TELEMETRY_API_KEY: 'secret',
      QUEUE_TELEMETRY_HOST: '127.0.0.1',
      QUEUE_TELEMETRY_MAX_BODY_BYTES: '1024',
      QUEUE_TELEMETRY_PATH: '/telemetry',
      QUEUE_TELEMETRY_PORT: '5000',
    });

    expect(collectorModule.createQueueTelemetryCollector).toHaveBeenCalledWith({
      apiKey: 'secret',
      host: '127.0.0.1',
      maxBodyBytes: 1024,
      path: '/telemetry',
      port: 5000,
    });
  });

  it('throws error for invalid port', async () => {
    await expect(
      cli.runQueueTelemetryCollectorCli({
        QUEUE_TELEMETRY_PORT: 'invalid',
      })
    ).rejects.toThrow('Invalid QUEUE_TELEMETRY_PORT value');

    await expect(
      cli.runQueueTelemetryCollectorCli({
        QUEUE_TELEMETRY_PORT: '-1',
      })
    ).rejects.toThrow('Invalid QUEUE_TELEMETRY_PORT value');

    await expect(
      cli.runQueueTelemetryCollectorCli({
        QUEUE_TELEMETRY_PORT: '70000',
      })
    ).rejects.toThrow('Invalid QUEUE_TELEMETRY_PORT value');
  });

  it('throws error for invalid max body bytes', async () => {
    await expect(
      cli.runQueueTelemetryCollectorCli({
        QUEUE_TELEMETRY_MAX_BODY_BYTES: 'invalid',
      })
    ).rejects.toThrow('Invalid QUEUE_TELEMETRY_MAX_BODY_BYTES value');

    await expect(
      cli.runQueueTelemetryCollectorCli({
        QUEUE_TELEMETRY_MAX_BODY_BYTES: '-100',
      })
    ).rejects.toThrow('Invalid QUEUE_TELEMETRY_MAX_BODY_BYTES value');
  });

  it('registers shutdown handlers', async () => {
    const onSpy = vi.spyOn(process, 'on');
    await cli.runQueueTelemetryCollectorCli({});

    expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
  });

  it('stops collector and exits cleanly on SIGINT', async () => {
    const handlers = new Map<string, () => Promise<void>>();
    vi.spyOn(process, 'on').mockImplementation(
      (event: Parameters<typeof process.on>[0], handler: (signal?: NodeJS.Signals) => void) => {
        if (event === 'SIGINT' || event === 'SIGTERM') {
          handlers.set(event, async () => {
            handler(event);
          });
        }
        return process;
      }
    );

    await cli.runQueueTelemetryCollectorCli({});

    const shutdown = handlers.get('SIGINT');
    expect(shutdown).toBeDefined();
    await shutdown?.();

    expect(cliMocks.stop).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('stops collector and exits cleanly on SIGTERM', async () => {
    const handlers = new Map<string, () => Promise<void>>();
    vi.spyOn(process, 'on').mockImplementation(
      (event: Parameters<typeof process.on>[0], handler: (signal?: NodeJS.Signals) => void) => {
        if (event === 'SIGINT' || event === 'SIGTERM') {
          handlers.set(event, async () => {
            handler(event);
          });
        }
        return process;
      }
    );

    await cli.runQueueTelemetryCollectorCli({});

    const shutdown = handlers.get('SIGTERM');
    expect(shutdown).toBeDefined();
    await shutdown?.();

    expect(cliMocks.stop).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('throws error for port value of zero', async () => {
    await expect(
      cli.runQueueTelemetryCollectorCli({
        QUEUE_TELEMETRY_PORT: '0',
      })
    ).rejects.toThrow('Invalid QUEUE_TELEMETRY_PORT value');
  });

  it('throws error for max body bytes value of zero', async () => {
    await expect(
      cli.runQueueTelemetryCollectorCli({
        QUEUE_TELEMETRY_MAX_BODY_BYTES: '0',
      })
    ).rejects.toThrow('Invalid QUEUE_TELEMETRY_MAX_BODY_BYTES value');
  });

  it('starts collector without optional apiKey', async () => {
    await cli.runQueueTelemetryCollectorCli({
      QUEUE_TELEMETRY_HOST: '127.0.0.1',
      QUEUE_TELEMETRY_PORT: '3000',
    });

    expect(collectorModule.createQueueTelemetryCollector).toHaveBeenCalledWith(
      expect.not.objectContaining({ apiKey: expect.anything() })
    );
  });
});
