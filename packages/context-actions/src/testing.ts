import { type ActionRegistry, createActionRegistry } from './registry';
import type { ActionServices, AnyContextAction, CapabilityKey } from './types';

/**
 * Registry for component tests: all capabilities granted, services recorded
 * in-memory. Pass `actions` to exercise real definitions.
 *
 * @param options.services - Override all services; when provided,
 * `writtenTexts` is not populated (the default in-memory clipboard is
 * bypassed).
 */
export function createTestActionRegistry(
  options: {
    actions?: readonly AnyContextAction[];
    capabilities?: readonly CapabilityKey[];
    services?: ActionServices;
  } = {}
): { registry: ActionRegistry; writtenTexts: string[] } {
  const writtenTexts: string[] = [];
  const defaultServices: ActionServices = {
    clipboard: {
      writeText: (text: string) => {
        writtenTexts.push(text);
        return Promise.resolve({ ok: true as const });
      },
    },
  };
  const services: ActionServices = options.services ?? defaultServices;
  const registry = createActionRegistry({
    actions: options.actions ?? [],
    capabilities: new Set(options.capabilities ?? ['clipboard', 'fs.reveal', 'fs.openPath']),
    services,
  });
  return { registry, writtenTexts };
}
