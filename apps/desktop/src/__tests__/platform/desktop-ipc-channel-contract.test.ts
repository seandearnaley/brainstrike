import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = path.resolve(process.cwd(), 'src');
const DIRECT_REGISTRY_CHANNEL_PATTERN =
  /registry\.register(?:Invoke|Event)\(\s*['"][^'"]+['"]\s*,\s*['"][^'"]+['"]/g;
const DIRECT_WEB_CONTENTS_SEND_CHANNEL_PATTERN = /webContents\.send\(\s*['"][^'"]+['"]/g;

function listProductionTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const absolutePath = path.join(directory, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      if (entry === '__tests__' || entry === 'dist') {
        continue;
      }
      files.push(...listProductionTypeScriptFiles(absolutePath));
      continue;
    }
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      files.push(absolutePath);
    }
  }
  return files;
}

describe('desktop IPC channel contract', () => {
  it('keeps shared platform channel constants owned by the central catalog', () => {
    const assistantToolsSource = readFileSync(
      path.join(SOURCE_ROOT, 'assistant-server', 'assistant-tools.ts'),
      'utf8'
    );
    const dbSharedSource = readFileSync(path.join(SOURCE_ROOT, 'db-shared.ts'), 'utf8');
    const embeddingHostSource = readFileSync(
      path.join(SOURCE_ROOT, 'embedding-host-shared.ts'),
      'utf8'
    );
    const parserHostSource = readFileSync(path.join(SOURCE_ROOT, 'parser-host-shared.ts'), 'utf8');
    const runtimeSource = readFileSync(path.join(SOURCE_ROOT, 'ipc-runtime.ts'), 'utf8');

    expect(assistantToolsSource).toContain("from '../platform/desktop-ipc-channels'");
    expect(assistantToolsSource).not.toMatch(/WORKSPACE_CONTEXT_[A-Z_]+_EVENT\s*=\s*['"]/);
    expect(dbSharedSource).toContain("from './platform/desktop-ipc-channels'");
    expect(dbSharedSource).not.toMatch(/DB_[A-Z_]+_CHANNEL\s*=\s*['"]/);
    expect(embeddingHostSource).not.toMatch(/EMBEDDING_HOST_[A-Z_]+_(?:CHANNEL|EVENT)\s*=\s*['"]/);
    expect(parserHostSource).toContain("from './platform/desktop-ipc-channels'");
    expect(parserHostSource).not.toMatch(/PARSER_HOST_PARSE_CHANNEL\s*=\s*['"]/);
    expect(runtimeSource).toContain("from './platform/desktop-ipc-channels'");
    expect(runtimeSource).not.toMatch(/RUNTIME_[A-Z_]+_CHANNEL\s*=\s*['"]/);
  });

  it('keeps production registry channel names behind named contracts', () => {
    const violations: string[] = [];

    for (const filePath of listProductionTypeScriptFiles(SOURCE_ROOT)) {
      const source = readFileSync(filePath, 'utf8');
      if (!source.includes('registry.register')) {
        continue;
      }
      for (const match of source.matchAll(DIRECT_REGISTRY_CHANNEL_PATTERN)) {
        const lineNumber = source.slice(0, match.index).split('\n').length;
        violations.push(`${path.relative(SOURCE_ROOT, filePath)}:${lineNumber}: ${match[0]}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps production webContents send channel names behind named contracts', () => {
    const violations: string[] = [];

    for (const filePath of listProductionTypeScriptFiles(SOURCE_ROOT)) {
      const source = readFileSync(filePath, 'utf8');
      if (!source.includes('webContents.send')) {
        continue;
      }
      for (const match of source.matchAll(DIRECT_WEB_CONTENTS_SEND_CHANNEL_PATTERN)) {
        const lineNumber = source.slice(0, match.index).split('\n').length;
        violations.push(`${path.relative(SOURCE_ROOT, filePath)}:${lineNumber}: ${match[0]}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
