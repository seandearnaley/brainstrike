import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseReleaseManifest } from './release-manifest';

// The checked-in manifest is exactly what the deployed site serves from its
// own origin. Parsing it with the production schema here means a release PR
// that lands a malformed manifest fails the site test lane instead of
// shipping a broken download chooser.
describe('public release manifest', () => {
  it('parses under the production schema', () => {
    const manifestPath = path.resolve(import.meta.dirname, '../../public/release-manifest.json');
    const raw: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(() => parseReleaseManifest(raw)).not.toThrow();
  });
});
