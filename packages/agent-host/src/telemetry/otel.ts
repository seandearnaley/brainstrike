import { runWithTimeout } from '@brainstrike/effect-kit';
import { HOST_VERSION } from '@brainstrike/host-lease';
import { createLogger } from '@brainstrike/logging';
import { registerTelemetry } from 'ai';
import { configureHostTelemetryContent } from './host-telemetry.js';

const logger = createLogger('AgentHostTracing');

export const HOST_TRACING_SERVICE_NAME = 'brainstrike-agent-host';
/** A slow or unreachable collector never holds the host's exit longer than this. */
export const HOST_TRACING_SHUTDOWN_TIMEOUT_MS = 1000;

export interface HostTracing {
  /** Flushes queued spans and shuts the provider down within the bounded wait. */
  shutdown(): Promise<void>;
}

interface HostTracingSettings {
  readonly recordContent: boolean;
  readonly url: string;
}

/** The OTel spec reads an empty variable as unset. */
function setting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/**
 * The OTLP/HTTP traces URL by the exporter spec: the signal variable is used as
 * is; the generic one gains `v1/traces`. The exporter's own reading of these
 * variables warns and falls back to localhost on a bad URL, so the host
 * resolves them. Messages name a variable, never its value, which may carry
 * credentials.
 */
function tracesUrl(env: NodeJS.ProcessEnv): string | undefined {
  const signal = setting(env, 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT');
  const generic = setting(env, 'OTEL_EXPORTER_OTLP_ENDPOINT');
  if (signal === undefined && generic === undefined) {
    return;
  }
  const url = signal ?? `${generic?.endsWith('/') ? generic : `${generic}/`}v1/traces`;
  if (!(URL.canParse(url) && ['http:', 'https:'].includes(new URL(url).protocol))) {
    const name = signal ? 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT' : 'OTEL_EXPORTER_OTLP_ENDPOINT';
    throw new Error(`${name} must be an http(s) URL`);
  }
  return url;
}

/** The OTLP/HTTP exporter encodes JSON; any other configured protocol would be ignored. */
function requireJsonProtocol(env: NodeJS.ProcessEnv): void {
  const name = setting(env, 'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL')
    ? 'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL'
    : 'OTEL_EXPORTER_OTLP_PROTOCOL';
  const protocol = setting(env, name);
  if (protocol !== undefined && protocol !== 'http/json') {
    throw new Error(`${name}=${protocol} is unsupported; the host exports http/json`);
  }
}

function recordsContent(env: NodeJS.ProcessEnv): boolean {
  const value = setting(env, 'BRAINSTRIKE_OTEL_RECORD_CONTENT');
  if (value !== undefined && value !== '0' && value !== '1') {
    throw new Error('BRAINSTRIKE_OTEL_RECORD_CONTENT must be 1 or 0');
  }
  return value === '1';
}

function tracingSettings(env: NodeJS.ProcessEnv): HostTracingSettings | undefined {
  const url = tracesUrl(env);
  if (url === undefined) {
    return;
  }
  requireJsonProtocol(env);
  return { recordContent: recordsContent(env), url };
}

/** The registered provider's flush; the SDK loads only once tracing is configured. */
async function registerHostTracing(settings: HostTracingSettings): Promise<() => Promise<void>> {
  const [
    { OpenTelemetry },
    { DiagLogLevel, diag },
    { OTLPTraceExporter },
    { resourceFromAttributes },
    { BatchSpanProcessor, NodeTracerProvider },
  ] = await Promise.all([
    import('@ai-sdk/otel'),
    import('@opentelemetry/api'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/sdk-trace-node'),
  ]);
  // The exporter reports its configuration warnings and every failed export
  // only to the SDK's diagnostic logger; without one they vanish.
  diag.setLogger(
    {
      debug: logger.debug,
      error: logger.error,
      info: logger.info,
      verbose: logger.trace,
      warn: logger.warn,
    },
    { logLevel: DiagLogLevel.WARN, suppressOverrideMessage: true }
  );
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      'service.name': HOST_TRACING_SERVICE_NAME,
      'service.version': HOST_VERSION,
    }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: settings.url }))],
  });
  provider.register();
  configureHostTelemetryContent(settings.recordContent);
  // Run and thread ids arrive as runtime context; hostTelemetry admits only those.
  registerTelemetry(new OpenTelemetry({ runtimeContext: true }));
  return () => provider.shutdown();
}

/**
 * Starts OTLP trace export of the host's AI SDK calls as OpenTelemetry GenAI
 * spans (`invoke_agent`, `chat`, `execute_tool`). Off unless an OTLP endpoint
 * variable is set; a set but unusable configuration logs one error and throws,
 * so the host never starts with tracing silently disabled.
 */
export async function startHostTracing(env: NodeJS.ProcessEnv): Promise<HostTracing | undefined> {
  try {
    const settings = tracingSettings(env);
    if (!settings) {
      return;
    }
    const shutdown = await registerHostTracing(settings);
    const endpoint = new URL(settings.url);
    logger.info('Host tracing started', {
      code: 'host_tracing_started',
      endpoint: `${endpoint.origin}${endpoint.pathname}`,
      recordContent: settings.recordContent,
    });
    return {
      shutdown: () =>
        runWithTimeout(shutdown, {
          onTimeout: () =>
            new Error(`Host tracing did not flush within ${HOST_TRACING_SHUTDOWN_TIMEOUT_MS} ms`),
          timeoutMs: HOST_TRACING_SHUTDOWN_TIMEOUT_MS,
        }),
    };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    logger.error('Host tracing could not start', { code: 'host_tracing_invalid', reason });
    throw new Error(`Host tracing could not start: ${reason}`, { cause });
  }
}
