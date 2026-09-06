import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listProviders,
  providerDeprecatedEnvKeys,
  providerEnvKeys,
} from '@brainstrike/assistant-contract/provider-metadata';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_ENV_FILE_VARIABLE_NAMES } from '../../desktop-env';
import { TAVILY_ENV_KEYS } from '../../tavily-env-keys';

/**
 * BST-1361: `.env.example` is the user-facing statement of the env-file
 * contract. It must track the provider registry — the canonical two names per
 * provider plus the Tavily pair, nothing else — so it can never drift into
 * documenting a name the loader rejects or a retired alias.
 */

const EXAMPLE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../.env.example'
);

/** Variable names mentioned by the example, commented (`# NAME=`) or active (`NAME=`). */
function readExampleVariableNames(): readonly string[] {
  const source = fs.readFileSync(EXAMPLE_PATH, 'utf8');
  const names: string[] = [];
  for (const line of source.split('\n')) {
    const match = /^#?\s*(?<name>[A-Z][A-Z0-9_]*)=/u.exec(line.trim());
    const name = match?.groups?.['name'];
    if (name) {
      names.push(name);
    }
  }
  return names;
}

describe('.env.example registry contract', () => {
  it('mentions only names the desktop env-file loader accepts', () => {
    const names = readExampleVariableNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(SUPPORTED_ENV_FILE_VARIABLE_NAMES.has(name), `unsupported name ${name}`).toBe(true);
    }
  });

  it('documents both canonical names of every keyed provider plus Tavily', () => {
    const names = new Set(readExampleVariableNames());
    for (const provider of listProviders()) {
      for (const envKey of providerEnvKeys(provider.id)) {
        expect(names.has(envKey), `${provider.id} name ${envKey} missing from .env.example`).toBe(
          true
        );
      }
    }
    for (const tavilyKey of TAVILY_ENV_KEYS) {
      expect(names.has(tavilyKey), `${tavilyKey} missing from .env.example`).toBe(true);
    }
  });

  it('never documents a deprecated name', () => {
    const names = new Set(readExampleVariableNames());
    for (const provider of listProviders()) {
      for (const deprecatedKey of providerDeprecatedEnvKeys(provider.id)) {
        expect(names.has(deprecatedKey), `deprecated ${deprecatedKey} in .env.example`).toBe(false);
      }
    }
  });
});
