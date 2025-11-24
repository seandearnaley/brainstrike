import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as cli from '../src/cli';
import * as collectorModule from '../src/collector';

// Mock dependencies
vi.mock('../src/collector', () => ({
  createQueueTelemetryCollector: vi.fn(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getEndpoint: vi.fn().mockReturnValue('http://localhost:4130/queue-telemetry'),
  })),
}));

vi.mock('@brainstrike/utils', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
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
    
    expect(collectorModule.createQueueTelemetryCollector).toHaveBeenCalledWith(expect.objectContaining({
      host: '0.0.0.0',
      port: 4130,
      path: '/queue-telemetry',
      maxBodyBytes: 256000,
    }));
  });

  it('starts collector with env var options', async () => {
    await cli.runQueueTelemetryCollectorCli({
      QUEUE_TELEMETRY_HOST: '127.0.0.1',
      QUEUE_TELEMETRY_PORT: '5000',
      QUEUE_TELEMETRY_PATH: '/telemetry',
      QUEUE_TELEMETRY_API_KEY: 'secret',
      QUEUE_TELEMETRY_MAX_BODY_BYTES: '1024',
    });
    
    expect(collectorModule.createQueueTelemetryCollector).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 5000,
      path: '/telemetry',
      apiKey: 'secret',
      maxBodyBytes: 1024,
    });
  });

  it('throws error for invalid port', async () => {
    await expect(cli.runQueueTelemetryCollectorCli({
      QUEUE_TELEMETRY_PORT: 'invalid',
    })).rejects.toThrow('Invalid QUEUE_TELEMETRY_PORT value');
    
    await expect(cli.runQueueTelemetryCollectorCli({
      QUEUE_TELEMETRY_PORT: '-1',
    })).rejects.toThrow('Invalid QUEUE_TELEMETRY_PORT value');
    
    await expect(cli.runQueueTelemetryCollectorCli({
      QUEUE_TELEMETRY_PORT: '70000',
    })).rejects.toThrow('Invalid QUEUE_TELEMETRY_PORT value');
  });

  it('throws error for invalid max body bytes', async () => {
    await expect(cli.runQueueTelemetryCollectorCli({
      QUEUE_TELEMETRY_MAX_BODY_BYTES: 'invalid',
    })).rejects.toThrow('Invalid QUEUE_TELEMETRY_MAX_BODY_BYTES value');
    
    await expect(cli.runQueueTelemetryCollectorCli({
      QUEUE_TELEMETRY_MAX_BODY_BYTES: '-100',
    })).rejects.toThrow('Invalid QUEUE_TELEMETRY_MAX_BODY_BYTES value');
  });

  it('registers shutdown handlers', async () => {
    const onSpy = vi.spyOn(process, 'on');
    await cli.runQueueTelemetryCollectorCli({});
    
    expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
  });
});

