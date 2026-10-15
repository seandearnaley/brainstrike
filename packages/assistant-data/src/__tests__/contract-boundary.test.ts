// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_ROOT = path.resolve(SRC_ROOT, '..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(SRC_ROOT, relativePath), 'utf8');
}

function listSourceFiles(dir = SRC_ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : listSourceFiles(absolute);
    }
    return /\.(ts|tsx)$/.test(entry.name) ? [absolute] : [];
  });
}

// The package's reason to exist (BST-983): a renderer-safe data layer that
// UI and composition layers depend on — never the other way around, and
// never on the Node-side agent runtime.
const FORBIDDEN_SPECIFIERS = [
  '@brainstrike/agent',
  '@brainstrike/app-shell',
  '@brainstrike/assistant-ui',
  '@brainstrike/ui',
] as const;

describe('assistant-data contract boundary', () => {
  it('reads assistant run events from assistant-contract instead of agent runtime', () => {
    expect(readSource('assistant-memory-repository.ts')).not.toMatch(
      /@brainstrike\/agent\/run-events/
    );
  });

  it('keeps thread draft runtime data structurally typed (no agent import)', () => {
    expect(readSource('assistant-thread-store.ts')).not.toMatch(/@brainstrike\/agent['"]/);
  });

  it('imports no UI, composition, or agent-runtime package from any source file', () => {
    for (const file of listSourceFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of FORBIDDEN_SPECIFIERS) {
        expect
          .soft(source, `${path.relative(SRC_ROOT, file)} imports ${specifier}`)
          .not.toMatch(new RegExp(`from '${specifier}(/|')`));
      }
    }
  });

  it('declares no dependency on UI, composition, or agent-runtime packages', () => {
    const manifest = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const specifier of FORBIDDEN_SPECIFIERS) {
      expect(manifest.dependencies ?? {}).not.toHaveProperty(specifier);
      expect(manifest.devDependencies ?? {}).not.toHaveProperty(specifier);
    }
  });
});
