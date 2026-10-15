import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  CATALOG_FILE,
  checkProviderCatalogKeyOrder,
  findCatalogKeyOrderFailures,
} from '../provider-catalog-key-order-guard.mjs';

const shippedProviderCatalog = JSON.parse(
  readFileSync(new URL(`../../${CATALOG_FILE}`, import.meta.url), 'utf8')
);

/**
 * Build an object whose keys are in the GIVEN order. The key-order fixtures
 * below must stay out of order to mean anything, and an object literal would
 * not: Biome's `useSortedKeys` assist sorts JS object properties, so one
 * `--write` run over this file would quietly sort the fixtures and leave the
 * tests passing while asserting nothing.
 */
function objectWithKeyOrder(entries) {
  const object = {};
  for (const [key, value] of entries) {
    object[key] = value;
  }
  return object;
}

/**
 * Ported verbatim from `model-catalog-migration-contract.test.mjs`, which was
 * retired with the migration chain (ADR-0020). These cases never exercised the
 * chain -- they are about one data file -- so they move with the check instead
 * of being deleted.
 */
describe('provider catalog key order', () => {
  it('rejects catalog objects whose keys are out of alphabetical order', () => {
    const failures = findCatalogKeyOrderFailures([
      objectWithKeyOrder([
        [
          'models',
          [
            objectWithKeyOrder([
              ['type', 'llm'],
              ['id', 'gpt-next'],
            ]),
          ],
        ],
        ['id', 'openai'],
      ]),
    ]);

    assert.deepEqual(failures, [
      {
        file: CATALOG_FILE,
        message:
          'Catalog entry openai declares "id" after "models"; provider-catalog.json object keys are alphabetical at every depth so catalog edits stay reviewable data diffs. Reorder this entry\'s keys.',
      },
      {
        file: CATALOG_FILE,
        message:
          'Catalog entry openai.models.gpt-next declares "id" after "type"; provider-catalog.json object keys are alphabetical at every depth so catalog edits stay reviewable data diffs. Reorder this entry\'s keys.',
      },
    ]);
  });

  it('names ONE offending key per object rather than every pair a shuffle disturbs', () => {
    const failures = findCatalogKeyOrderFailures([
      objectWithKeyOrder([
        ['runtime', 'hosted'],
        ['id', 'openai'],
        ['models', []],
        ['displayName', 'OpenAI'],
      ]),
    ]);

    assert.deepEqual(
      failures.map((failure) => failure.message),
      [
        'Catalog entry openai declares "id" after "runtime"; provider-catalog.json object keys are alphabetical at every depth so catalog edits stay reviewable data diffs. Reorder this entry\'s keys.',
      ],
      'a reviewer needs the first key to move, not one failure per disturbed pair'
    );
  });

  it('accepts _note first and reports a nested object by its own path', () => {
    const failures = findCatalogKeyOrderFailures([
      {
        _note: 'vendor citation',
        id: 'openai',
        models: [
          objectWithKeyOrder([
            ['_note', 'row citation'],
            ['id', 'gpt-next'],
            [
              'pricing',
              objectWithKeyOrder([
                ['outputPerMTok', 30],
                ['inputPerMTok', 5],
              ]),
            ],
            ['type', 'llm'],
          ]),
        ],
      },
    ]);

    assert.deepEqual(
      failures.map((failure) => failure.message),
      [
        'Catalog entry openai.models.gpt-next.pricing declares "inputPerMTok" after "outputPerMTok"; provider-catalog.json object keys are alphabetical at every depth so catalog edits stay reviewable data diffs. Reorder this entry\'s keys.',
      ],
      '`_note` sorts before every other catalog key, and nested objects are checked too'
    );
  });

  it('holds the shipped catalog to the order it already keeps', () => {
    assert.deepEqual(findCatalogKeyOrderFailures(shippedProviderCatalog), []);
  });

  it('reads the shipped catalog off disk and passes', async () => {
    assert.deepEqual(await checkProviderCatalogKeyOrder(), { failures: [] });
  });
});
