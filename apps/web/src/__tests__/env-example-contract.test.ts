import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerDeprecatedEnvKeys, providerEnvKeys } from '@brainstrike/agent/hosted-web';
import { describe, expect, it } from 'vitest';
import { HOSTED_WEB_ASSISTANT_PROVIDERS } from '../server/assistant-config';

/**
 * BST-1361 (review 2): `apps/web/.env.example` documents the Hosted Web
 * credential surface and must track the provider registry — the canonical
 * two names per web-supported provider, no retired alias, no name the
 * resolver would ignore. The desktop counterpart lives beside desktop-env
 * (`apps/desktop/src/__tests__/main/env-example-contract.test.ts`); each app
 * pins ITS OWN example so no test reads across package boundaries.
 */

const EXAMPLE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.env.example'
);

/** API-key-shaped variable names mentioned by the example, commented or active. */
function readExampleApiKeyNames(): readonly string[] {
  const source = fs.readFileSync(EXAMPLE_PATH, 'utf8');
  const names: string[] = [];
  for (const line of source.split('\n')) {
    const match = /^#?\s*(?<name>[A-Z][A-Z0-9_]*_API_KEY)=/u.exec(line.trim());
    const name = match?.groups?.['name'];
    if (name) {
      names.push(name);
    }
  }
  return names;
}

describe('.env.example registry contract (hosted web)', () => {
  const canonicalNames = new Set(HOSTED_WEB_ASSISTANT_PROVIDERS.flatMap(providerEnvKeys));

  it('mentions only canonical names of web-supported providers', () => {
    const names = readExampleApiKeyNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(canonicalNames.has(name), `non-canonical name ${name} in apps/web/.env.example`).toBe(
        true
      );
    }
  });

  it('documents both canonical names of every web-supported provider', () => {
    const names = new Set(readExampleApiKeyNames());
    for (const provider of HOSTED_WEB_ASSISTANT_PROVIDERS) {
      for (const envKey of providerEnvKeys(provider)) {
        expect(names.has(envKey), `${provider} name ${envKey} missing from .env.example`).toBe(
          true
        );
      }
    }
  });

  it('never documents a deprecated name', () => {
    const source = fs.readFileSync(EXAMPLE_PATH, 'utf8');
    for (const provider of HOSTED_WEB_ASSISTANT_PROVIDERS) {
      for (const deprecatedKey of providerDeprecatedEnvKeys(provider)) {
        // Whole-identifier match: BRAINSTRIKE_GOOGLE_API_KEY legitimately
        // CONTAINS the deprecated GOOGLE_API_KEY as a substring.
        const wholeName = new RegExp(`(?<![A-Z0-9_])${deprecatedKey}(?![A-Z0-9_])`, 'u');
        expect(wholeName.test(source), `deprecated ${deprecatedKey} in .env.example`).toBe(false);
      }
    }
  });
});
