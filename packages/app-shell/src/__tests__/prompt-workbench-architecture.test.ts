// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(SOURCE_ROOT, relativePath), 'utf8');
}

describe('Prompt Workbench architecture', () => {
  it('keeps ConnectedPromptManager as composition over an owned library controller', () => {
    const source = readSource('connected-prompt-manager.tsx');
    // The component stays the final declaration so the EOF anchor measures its complete source.
    const componentMatch = source.match(/export function ConnectedPromptManager\([\s\S]*\n}\s*$/);

    expect(componentMatch).not.toBeNull();

    const componentSource = componentMatch?.[0].trimEnd() ?? '';
    expect(componentSource.split('\n').length).toBeLessThanOrEqual(300);
    expect(source).toContain("from './use-prompt-library-controller'");
    expect(componentSource).toContain('usePromptLibraryController({');
    expect(source).not.toContain("from './prompt-embedding-model-info'");
    expect(source).not.toContain("from './prompt-library-embedding'");
  });
});
