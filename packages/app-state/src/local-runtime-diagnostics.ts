import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import type {
  LocalRuntimeAvailabilityState,
  LocalRuntimeId,
  LocalRuntimeModelCatalogState,
} from '@brainstrike/local-runtime';
import { createLogger } from '@brainstrike/logging';

const logger = createLogger('LocalRuntimeDiagnostics');

/** Only bounded dimensions cross this boundary: never a result, error, URL or model id. */
export async function withLocalRuntimeDiagnostics<
  T extends LocalRuntimeAvailabilityState | LocalRuntimeModelCatalogState,
>(
  operation: 'probe' | 'models',
  runtime: LocalRuntimeId,
  route: 'native-bridge' | 'browser-service',
  work: () => Promise<T>
): Promise<T> {
  const prefix = operation === 'probe' ? 'local_provider_probe' : 'local_models_list';
  logger.info(`${prefix}_started`, { code: `${prefix}_started`, route, runtime, schemaVersion: 1 });
  try {
    const result = await work();
    logger.info(`${prefix}_result`, {
      code: `${prefix}_result`,
      route,
      runtime,
      schemaVersion: 1,
      state: result.state,
    });
    return result;
  } catch (error) {
    logger.warn(`${prefix}_result`, {
      code: `${prefix}_result`,
      route,
      runtime,
      schemaVersion: 1,
      state: 'error',
    });
    throw error;
  }
}

export function recordAssistantModelDiagnostic(
  code: 'assistant_model_selected' | 'assistant_model_unavailable_shown',
  provider: SupportedProvider
): void {
  logger.info(code, { code, provider, schemaVersion: 1 });
}
