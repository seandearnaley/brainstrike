export type ModelRegistrySqlRuntime = 'libsql' | 'pglite' | 'turso';

export interface ModelRegistryToggleStatement {
  readonly params: readonly [boolean | number, string, string];
  readonly sql: string;
}

interface BuildModelToggleStatementInput {
  readonly enabled: boolean;
  readonly modelId: string;
  readonly runtimeEngine: ModelRegistrySqlRuntime;
  readonly updatedAt: string;
}

interface BuildProviderToggleStatementInput {
  readonly enabled: boolean;
  readonly providerId: string;
  readonly runtimeEngine: ModelRegistrySqlRuntime;
  readonly updatedAt: string;
}

function resolveEnabledParam(
  runtimeEngine: ModelRegistrySqlRuntime,
  enabled: boolean
): boolean | 0 | 1 {
  return runtimeEngine === 'pglite' ? enabled : enabled ? 1 : 0;
}

function buildToggleStatement(args: {
  readonly enabled: boolean;
  readonly id: string;
  readonly runtimeEngine: ModelRegistrySqlRuntime;
  readonly tableName: 'models' | 'providers';
  readonly updatedAt: string;
}): ModelRegistryToggleStatement {
  const [enabledPlaceholder, updatedAtPlaceholder, idPlaceholder] =
    args.runtimeEngine === 'pglite' ? ['$1', '$2', '$3'] : ['?', '?', '?'];

  return {
    params: [resolveEnabledParam(args.runtimeEngine, args.enabled), args.updatedAt, args.id],
    sql: `UPDATE ${args.tableName} SET is_enabled = ${enabledPlaceholder}, updated_at = ${updatedAtPlaceholder} WHERE id = ${idPlaceholder}`,
  };
}

export function buildModelToggleStatement(
  args: BuildModelToggleStatementInput
): ModelRegistryToggleStatement {
  return buildToggleStatement({
    enabled: args.enabled,
    id: args.modelId,
    runtimeEngine: args.runtimeEngine,
    tableName: 'models',
    updatedAt: args.updatedAt,
  });
}

export function buildProviderToggleStatement(
  args: BuildProviderToggleStatementInput
): ModelRegistryToggleStatement {
  return buildToggleStatement({
    enabled: args.enabled,
    id: args.providerId,
    runtimeEngine: args.runtimeEngine,
    tableName: 'providers',
    updatedAt: args.updatedAt,
  });
}

export function resolveModelRegistrySqlRuntime(runtimeEngine: unknown): ModelRegistrySqlRuntime {
  if (runtimeEngine === 'libsql' || runtimeEngine === 'pglite' || runtimeEngine === 'turso') {
    return runtimeEngine;
  }
  throw new Error(`Unsupported model registry SQL runtime: ${String(runtimeEngine)}`);
}
