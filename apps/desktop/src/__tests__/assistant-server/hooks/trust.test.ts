import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookTrustRequest } from '@brainstrike/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveTrustedRoots, sha256OfFile } from '../../../assistant-server/hooks/trust';

let tmpRoot: string;

function writeProjectHooks(rootAbsPath: string, content: string): string {
  const dir = join(rootAbsPath, '.brainstrike');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'hooks.json');
  writeFileSync(file, content, 'utf8');
  return file;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'bs-hooks-trust-'));
});

afterEach(() => {
  rmSync(tmpRoot, { force: true, recursive: true });
});

describe('sha256OfFile', () => {
  it('hashes an existing file and returns null for a missing one', () => {
    const content = '{"a":1}';
    const file = writeProjectHooks(tmpRoot, content);
    expect(sha256OfFile(file)).toBe(sha256(content));
    expect(sha256OfFile(join(tmpRoot, 'nope.json'))).toBeNull();
  });
});

describe('resolveTrustedRoots', () => {
  it('marks a root trusted only when the disk hash matches an approval', () => {
    const content = '{"PreToolUse":[]}';
    writeProjectHooks(tmpRoot, content);
    const request: HookTrustRequest = {
      approvals: [{ approvedAt: 1, rootId: 'r1', sha256: sha256(content) }],
    };
    const map = resolveTrustedRoots([{ absPath: tmpRoot, rootId: 'r1' }], request);
    expect(map.get('r1')).toBe(true);
  });

  it('marks a root untrusted when the file content has changed since approval', () => {
    writeProjectHooks(tmpRoot, '{"changed":true}');
    const request: HookTrustRequest = {
      approvals: [{ approvedAt: 1, rootId: 'r1', sha256: sha256('{"old":true}') }],
    };
    const map = resolveTrustedRoots([{ absPath: tmpRoot, rootId: 'r1' }], request);
    expect(map.get('r1')).toBe(false);
  });

  it('marks a root untrusted when its hooks file is missing', () => {
    const request: HookTrustRequest = {
      approvals: [{ approvedAt: 1, rootId: 'r1', sha256: sha256('x') }],
    };
    const map = resolveTrustedRoots([{ absPath: tmpRoot, rootId: 'r1' }], request);
    expect(map.get('r1')).toBe(false);
  });

  it('marks a root untrusted when no approval exists for it', () => {
    writeProjectHooks(tmpRoot, '{"a":1}');
    const map = resolveTrustedRoots([{ absPath: tmpRoot, rootId: 'r1' }], { approvals: [] });
    expect(map.get('r1')).toBe(false);
  });

  it('marks a root untrusted when the request is undefined', () => {
    writeProjectHooks(tmpRoot, '{"a":1}');
    const map = resolveTrustedRoots([{ absPath: tmpRoot, rootId: 'r1' }], undefined);
    expect(map.get('r1')).toBe(false);
  });

  it('does not cross-apply one root approval to a different rootId', () => {
    const content = '{"a":1}';
    writeProjectHooks(tmpRoot, content);
    const request: HookTrustRequest = {
      approvals: [{ approvedAt: 1, rootId: 'other', sha256: sha256(content) }],
    };
    const map = resolveTrustedRoots([{ absPath: tmpRoot, rootId: 'r1' }], request);
    expect(map.get('r1')).toBe(false);
  });
});
