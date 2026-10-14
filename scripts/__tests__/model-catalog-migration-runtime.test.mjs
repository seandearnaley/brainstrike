import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  analyzeModelCatalogMigrationContract,
  CATALOG_FILE,
  readMigrationFiles,
} from '../model-catalog-migration-contract.mjs';

const shippedProviderCatalog = JSON.parse(
  readFileSync(new URL(`../../${CATALOG_FILE}`, import.meta.url), 'utf8')
);

// The current seed projects the canonical provider catalog at module load.
// Validate the exported SQL itself; source interpolation is not SQL.
describe('executed current catalog migration SQL', () => {
  it('checks generated seed rows and still detects omitted or incorrect models', async () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const files = await readMigrationFiles(root);
    const input = {
      assistantPreferencesSource: readFileSync(
        new URL(
          '../../packages/app-state/src/stores/assistant-model-id-migrations.ts',
          import.meta.url
        ),
        'utf8'
      ),
      memoryPreferencesSource: readFileSync(
        new URL(
          '../../packages/app-state/src/stores/assistant-memory-preferences-store.ts',
          import.meta.url
        ),
        'utf8'
      ),
      migrationFiles: files,
      migrationIndexSource: readFileSync(
        new URL('../../packages/db/src/migrations/index.ts', import.meta.url),
        'utf8'
      ),
      providerCatalog: shippedProviderCatalog,
    };
    const seed = files.find(({ file }) => file.endsWith('/149-granite-local-embedding-profile.ts'));
    assert.equal(typeof seed?.upSql, 'string');
    assert.deepEqual(analyzeModelCatalogMigrationContract(input).failures, []);
    assert.throws(
      () =>
        analyzeModelCatalogMigrationContract({
          ...input,
          migrationFiles: files.map((file) => (file === seed ? { ...file, upSql: '' } : file)),
        }),
      /Migration SQL is not a nonempty string/
    );
    const omitted = analyzeModelCatalogMigrationContract({
      ...input,
      migrationIndexSource: input.migrationIndexSource.replace(
        '  migration149GraniteLocalEmbeddingProfile,',
        ''
      ),
    });
    assert.ok(
      omitted.failures.some(({ message }) =>
        message.includes('migration149GraniteLocalEmbeddingProfile is missing')
      )
    );
    const incorrect = analyzeModelCatalogMigrationContract({
      ...input,
      migrationFiles: files.map((file) =>
        file === seed
          ? {
              ...file,
              upSql: `${file.upSql}\nDELETE FROM models WHERE id IN ('Xenova/bge-small-en-v1.5');`,
            }
          : file
      ),
    });
    assert.ok(
      incorrect.failures.some(({ message }) =>
        message.includes('local::Xenova/bge-small-en-v1.5 is missing')
      )
    );
    const unsafe = analyzeModelCatalogMigrationContract({
      ...input,
      migrationFiles: files.map((file) =>
        file === seed
          ? {
              ...file,
              upSql: `${file.upSql}\nUPDATE models SET updated_at = NOW();`,
            }
          : file
      ),
    });
    assert.ok(unsafe.failures.some(({ message }) => message.includes('writes models.updated_at')));
  });
});
