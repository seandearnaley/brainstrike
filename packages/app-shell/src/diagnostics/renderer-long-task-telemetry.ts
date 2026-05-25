import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('RendererLongTaskTelemetry');

export type RendererRouteSurface = 'explorer' | 'prompts' | 'settings' | 'unknown';

export interface RendererLongTaskTelemetryContext {
  feature?: string;
  route: RendererRouteSurface;
}

export interface RendererLongTaskTelemetryMetric {
  durationMs: number;
  event: 'renderer.long-task';
  feature?: string;
  route: RendererRouteSurface;
}

const ROUTE_BY_PATH: Readonly<Record<string, RendererRouteSurface>> = {
  '/': 'explorer',
  '/prompts': 'prompts',
  '/settings': 'settings',
};

export function normalizeRendererRoute(path: string): RendererRouteSurface {
  return ROUTE_BY_PATH[path] ?? 'unknown';
}

export function recordRendererLongTaskTelemetry(metric: RendererLongTaskTelemetryMetric): void {
  logger.debug('Renderer long-task telemetry', metric);
}

export function createRendererLongTaskObserver(
  getContext: () => RendererLongTaskTelemetryContext
): () => void {
  if (typeof PerformanceObserver === 'undefined') {
    return () => {};
  }

  let observer: PerformanceObserver | null = null;

  try {
    observer = new PerformanceObserver((list) => {
      const context = getContext();
      for (const entry of list.getEntries()) {
        if (entry.entryType !== 'longtask') {
          continue;
        }
        recordRendererLongTaskTelemetry({
          durationMs: entry.duration,
          event: 'renderer.long-task',
          route: context.route,
          ...(context.feature ? { feature: context.feature } : {}),
        });
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch {
    observer = null;
  }

  return () => {
    observer?.disconnect();
    observer = null;
  };
}
