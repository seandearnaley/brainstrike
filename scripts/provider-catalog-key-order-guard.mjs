#!/usr/bin/env node
/**
 * `provider-catalog.json` object keys must stay alphabetical at every depth.
 *
 * Extracted from `scripts/model-catalog-migration-contract.mjs`, which was
 * retired when the db migration chain collapsed into a single current-schema
 * DDL (ADR-0020): that contract reconstructed the model catalog by REPLAYING the
 * chain's catalog mutations and enforced a removed-model remap decision per
 * incremental deletion, and neither has any input once there are no incremental
 * migrations -- it went from 42 catalog-mutating migrations checked to 1.
 *
 * This check never depended on any of that. It reads one data file and is kept
 * verbatim, with its tests, because nothing else enforces it: `biome.json`
 * re-includes this path so the file is FORMATTED, but Biome's `useSortedKeys`
 * assist does not reach JSON object keys.
 *
 * Usage: node scripts/provider-catalog-key-order-guard.mjs
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CATALOG_FILE = 'packages/assistant-contract/src/provider-catalog.json';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `provider-catalog.json` already declares every object's keys in ascending
 * order, at every depth, with no exception in the whole file. That property is
 * what makes BST-1650's promise hold — catalog edits read as data diffs — and
 * it is the file the team edits weekly: two model rows line up field for
 * field, and a field added by one author cannot land in a different slot than
 * the same field on the row below.
 *
 * NOTHING enforced it. `biome.json` re-includes this one path from the blanket
 * `!**\/*.json` so the file is FORMATTED, but Biome's `useSortedKeys` assist
 * does not reach JSON object keys — unsorting a row and running
 * `biome check packages/assistant-contract/src/provider-catalog.json` reports
 * nothing. So the check lives here, run by `pnpm lint:catalog-key-order`.
 *
 * Two deliberate limits:
 *
 * - ROW order is NOT checked. The catalog lists `gpt-5.6-sol` before
 *   `gpt-5.6-terra` and `claude-opus-5` before `claude-sonnet-5`: curated
 *   editorial order that no comparator derives. Inventing a row rule would
 *   churn the file this check exists to keep quiet.
 * - Nothing is auto-fixed. A silent reorder of a data file is an invisible
 *   change to the very rows a reviewer is reading, so a wrong order FAILS and
 *   names the entry to reorder.
 */
function compareCatalogKeys(left, right) {
  // Code-unit order, which is exactly what `Object.keys(...).sort()` yields, so
  // the rule reads the same on every machine. `localeCompare` would make the
  // check locale-dependent and would not agree with the file about `_note`.
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function catalogArraySegment(entry, index) {
  const id = isPlainObject(entry) && typeof entry.id === 'string' ? entry.id : null;
  return id ?? `[${index}]`;
}

function describeCatalogPath(path) {
  return path.length > 0 ? path.join('.') : 'the provider catalog root';
}

function visitCatalogObjects(value, path, visit) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      visitCatalogObjects(entry, [...path, catalogArraySegment(entry, index)], visit);
    });
    return;
  }

  if (!isPlainObject(value)) {
    return;
  }

  visit(value, path);
  for (const [key, nested] of Object.entries(value)) {
    visitCatalogObjects(nested, [...path, key], visit);
  }
}

/**
 * Report the FIRST out-of-order key of each catalog object. One failure per
 * object, not one per disturbed pair: a reviewer needs the key to move, and a
 * shuffled row would otherwise bury the other failures under its own noise.
 */
export function findCatalogKeyOrderFailures(catalog) {
  const failures = [];

  visitCatalogObjects(catalog, [], (entry, path) => {
    const keys = Object.keys(entry);
    for (let index = 1; index < keys.length; index += 1) {
      const previous = keys[index - 1];
      const current = keys[index];
      if (compareCatalogKeys(previous, current) <= 0) {
        continue;
      }

      failures.push({
        file: CATALOG_FILE,
        message: `Catalog entry ${describeCatalogPath(path)} declares "${current}" after "${previous}"; provider-catalog.json object keys are alphabetical at every depth so catalog edits stay reviewable data diffs. Reorder this entry's keys.`,
      });
      return;
    }
  });

  return failures;
}

export async function checkProviderCatalogKeyOrder({ root = REPO_ROOT } = {}) {
  const source = await readFile(path.join(root, CATALOG_FILE), 'utf8');
  return { failures: findCatalogKeyOrderFailures(JSON.parse(source)) };
}

async function main() {
  const { failures } = await checkProviderCatalogKeyOrder();
  if (failures.length > 0) {
    console.error('Provider catalog key order failed.');
    console.error(
      'provider-catalog.json object keys are alphabetical at every depth so catalog edits stay reviewable data diffs.'
    );
    for (const failure of failures) {
      console.error(`- ${failure.file}: ${failure.message}`);
    }
    process.exit(1);
  }

  console.log('Provider catalog key order passed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
