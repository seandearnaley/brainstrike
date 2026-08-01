import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ALWAYS_DENY_READ_PATHS,
  buildSandboxRuntimeConfig,
  FencePolicyError,
  isFencePolicyError,
} from '../fence/fence-policy';

const scratchDir = join(homedir(), 'scratch-does-not-need-to-exist');

describe('ALWAYS_DENY_READ_PATHS', () => {
  it('covers the credential stores that must never be readable by sandboxed code', () => {
    expect(ALWAYS_DENY_READ_PATHS).toContain(join(homedir(), '.ssh'));
    expect(ALWAYS_DENY_READ_PATHS).toContain(join(homedir(), '.aws'));
  });

  it('is expressed as absolute literals — no tilde to expand, no glob to skip re-emission', () => {
    for (const path of ALWAYS_DENY_READ_PATHS) {
      expect(isAbsolute(path)).toBe(true);
      expect(path).not.toContain('~');
      expect(path).not.toContain('*');
    }
  });
});

describe('buildSandboxRuntimeConfig', () => {
  it('maps allowWrite, allowedDomains, allowRead and denyRead onto SandboxRuntimeConfig', () => {
    const config = buildSandboxRuntimeConfig(
      {
        allowedDomains: ['api.github.com'],
        allowRead: ['/opt/data'],
        allowWrite: ['/opt/out'],
        denyRead: ['/opt/data/secret'],
      },
      scratchDir
    );

    expect(config.network.allowedDomains).toEqual(['api.github.com']);
    expect(config.network.deniedDomains).toEqual([]);
    expect(config.filesystem.allowWrite).toEqual([scratchDir, '/opt/out']);
    expect(config.filesystem.denyWrite).toEqual([]);
    expect(config.filesystem.allowRead).toEqual(['/opt/data']);
    expect(config.filesystem.denyRead).toEqual([...ALWAYS_DENY_READ_PATHS, '/opt/data/secret']);
  });

  it('keeps an empty allowedDomains list verbatim — that IS the no-network state', () => {
    const config = buildSandboxRuntimeConfig({ allowedDomains: [], allowWrite: [] }, scratchDir);
    expect(config.network.allowedDomains).toEqual([]);
  });

  it('always denies the credential stores even when the policy denies nothing', () => {
    const config = buildSandboxRuntimeConfig({ allowedDomains: [], allowWrite: [] }, scratchDir);
    expect(config.filesystem.denyRead).toEqual([...ALWAYS_DENY_READ_PATHS]);
  });

  it('always makes the scratch dir writable, and lists it first', () => {
    const config = buildSandboxRuntimeConfig(
      { allowedDomains: [], allowWrite: ['/opt/out'] },
      scratchDir
    );
    expect(config.filesystem.allowWrite[0]).toBe(scratchDir);
  });

  it('rejects a policy whose allowRead re-opens an always-denied credential store', () => {
    let caught: unknown;
    try {
      buildSandboxRuntimeConfig(
        { allowedDomains: [], allowRead: ['~/.ssh'], allowWrite: [] },
        scratchDir
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FencePolicyError);
    expect(isFencePolicyError(caught)).toBe(true);
    if (!isFencePolicyError(caught)) {
      throw new Error('unreachable');
    }
    expect(caught.code).toBe('fence_policy_invalid');
    expect(caught.message).toContain('~/.ssh');
  });

  it('rejects an allowRead nested INSIDE an always-denied store (the real re-open shape)', () => {
    expect(() =>
      buildSandboxRuntimeConfig(
        { allowedDomains: [], allowRead: [join(homedir(), '.ssh', 'id_ed25519')], allowWrite: [] },
        scratchDir
      )
    ).toThrowError(FencePolicyError);
  });

  it('allows an allowRead ANCESTOR of a denied store — srt re-applies the nested deny', () => {
    expect(() =>
      buildSandboxRuntimeConfig(
        { allowedDomains: [], allowRead: [homedir()], allowWrite: [] },
        scratchDir
      )
    ).not.toThrow();
  });

  it('rejects a relative scratch dir instead of resolving it against an implicit cwd', () => {
    expect(() =>
      buildSandboxRuntimeConfig({ allowedDomains: [], allowWrite: [] }, 'relative/scratch')
    ).toThrowError(FencePolicyError);
  });

  it('re-validates the policy strictly at the sandbox boundary', () => {
    expect(() =>
      buildSandboxRuntimeConfig(
        // A caller that bypassed the seam's schema must still be rejected here.
        { allowedDomains: [], allowNetwork: true, allowWrite: [] } as never,
        scratchDir
      )
    ).toThrowError();
    expect(() =>
      buildSandboxRuntimeConfig({ allowedDomains: [] } as never, scratchDir)
    ).toThrowError();
  });
});
