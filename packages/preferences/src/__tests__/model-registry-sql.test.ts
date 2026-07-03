import { describe, expect, it } from 'vitest';
import {
  buildModelToggleStatement,
  buildProviderToggleStatement,
  resolveModelRegistrySqlRuntime,
} from '../stores/model-registry-sql';

describe('model registry runtime SQL', () => {
  it('keeps PostgreSQL placeholders and booleans for PGlite model toggles', () => {
    expect(
      buildModelToggleStatement({
        enabled: true,
        modelId: 'model-1',
        runtimeEngine: 'pglite',
        updatedAt: '2026-07-02T22:00:00.000Z',
      })
    ).toEqual({
      params: [true, '2026-07-02T22:00:00.000Z', 'model-1'],
      sql: 'UPDATE models SET is_enabled = $1, updated_at = $2 WHERE id = $3',
    });
  });

  it('uses SQLite placeholders and integer booleans for Turso model toggles', () => {
    expect(
      buildModelToggleStatement({
        enabled: false,
        modelId: 'model-1',
        runtimeEngine: 'turso',
        updatedAt: '2026-07-02T22:00:00.000Z',
      })
    ).toEqual({
      params: [0, '2026-07-02T22:00:00.000Z', 'model-1'],
      sql: 'UPDATE models SET is_enabled = ?, updated_at = ? WHERE id = ?',
    });
  });

  it('uses SQLite placeholders and integer booleans for Turso provider toggles', () => {
    expect(
      buildProviderToggleStatement({
        enabled: true,
        providerId: 'openai',
        runtimeEngine: 'turso',
        updatedAt: '2026-07-02T22:00:00.000Z',
      })
    ).toEqual({
      params: [1, '2026-07-02T22:00:00.000Z', 'openai'],
      sql: 'UPDATE providers SET is_enabled = ?, updated_at = ? WHERE id = ?',
    });
  });

  it('treats libsql as an explicit SQLite dialect runtime', () => {
    expect(resolveModelRegistrySqlRuntime('libsql')).toBe('libsql');
    expect(
      buildModelToggleStatement({
        enabled: true,
        modelId: 'model-1',
        runtimeEngine: 'libsql',
        updatedAt: '2026-07-02T22:00:00.000Z',
      })
    ).toEqual({
      params: [1, '2026-07-02T22:00:00.000Z', 'model-1'],
      sql: 'UPDATE models SET is_enabled = ?, updated_at = ? WHERE id = ?',
    });
  });

  it('rejects unknown runtimes instead of guessing a SQL dialect', () => {
    expect(() => resolveModelRegistrySqlRuntime('unknown')).toThrow(
      'Unsupported model registry SQL runtime: unknown'
    );
  });
});
