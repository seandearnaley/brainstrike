import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ALWAYS_DENY_READ_PATHS,
  buildSandboxRuntimeConfig,
  type FencePathResolver,
  FencePolicyError,
  isFencePolicyError,
} from '../fence/fence-policy';

const scratchDir = join(homedir(), 'scratch-does-not-need-to-exist');

/**
 * Stands in for `fs.realpath`. Paths resolve to themselves unless `links` says
 * otherwise, and anything in `missing` fails the way realpath fails on ENOENT.
 * Injecting this is what keeps the mapping in the cacheable unit lane: the
 * decisions under test are about policy, not about this host's directories.
 */
function fakeResolver(
  options: { links?: Record<string, string>; missing?: readonly string[] } = {}
): FencePathResolver {
  return (path: string) => {
    if (options.missing?.includes(path)) {
      return Promise.reject(
        Object.assign(new Error(`ENOENT: no such file or directory, realpath '${path}'`), {
          code: 'ENOENT',
        })
      );
    }
    return Promise.resolve(options.links?.[path] ?? path);
  };
}

const resolver = fakeResolver();

const build = (
  policy: Parameters<typeof buildSandboxRuntimeConfig>[0],
  dir = scratchDir,
  resolvePath: FencePathResolver = resolver
) => buildSandboxRuntimeConfig(policy, dir, resolvePath);

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
  it('maps allowWrite, allowedDomains, allowRead and denyRead onto SandboxRuntimeConfig', async () => {
    const config = await build({
      allowedDomains: ['api.github.com'],
      allowRead: ['/opt/data'],
      allowWrite: ['/opt/out'],
      denyRead: ['/opt/data/secret'],
    });

    expect(config.network.allowedDomains).toEqual(['api.github.com']);
    expect(config.network.deniedDomains).toEqual([]);
    expect(config.filesystem.allowWrite).toEqual([scratchDir, '/opt/out']);
    expect(config.filesystem.denyWrite).toEqual([]);
    expect(config.filesystem.allowRead).toEqual(['/opt/data']);
    expect(config.filesystem.denyRead).toEqual([...ALWAYS_DENY_READ_PATHS, '/opt/data/secret']);
  });

  it('keeps an empty allowedDomains list verbatim — that IS the no-network state', async () => {
    const config = await build({ allowedDomains: [], allowWrite: [] });
    expect(config.network.allowedDomains).toEqual([]);
  });

  it('always denies the credential stores even when the policy denies nothing', async () => {
    const config = await build({ allowedDomains: [], allowWrite: [] });
    expect(config.filesystem.denyRead).toEqual([...ALWAYS_DENY_READ_PATHS]);
  });

  it('always makes the scratch dir writable, and lists it first', async () => {
    const config = await build({ allowedDomains: [], allowWrite: ['/opt/out'] });
    expect(config.filesystem.allowWrite[0]).toBe(scratchDir);
  });

  it('rejects a policy whose allowRead re-opens an always-denied credential store', async () => {
    let caught: unknown;
    try {
      await build({ allowedDomains: [], allowRead: [join(homedir(), '.ssh')], allowWrite: [] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FencePolicyError);
    expect(isFencePolicyError(caught)).toBe(true);
    if (!isFencePolicyError(caught)) {
      throw new Error('unreachable');
    }
    expect(caught.code).toBe('fence_policy_invalid');
    expect(caught.message).toContain(join(homedir(), '.ssh'));
  });

  it('rejects an allowRead nested INSIDE an always-denied store (the real re-open shape)', async () => {
    await expect(
      build({
        allowedDomains: [],
        allowRead: [join(homedir(), '.ssh', 'id_ed25519')],
        allowWrite: [],
      })
    ).rejects.toBeInstanceOf(FencePolicyError);
  });

  it('allows an allowRead ANCESTOR of a denied store — srt re-applies the nested deny', async () => {
    await expect(
      build({ allowedDomains: [], allowRead: [homedir()], allowWrite: [] })
    ).resolves.toBeDefined();
  });

  it('REJECTS a root-wide allowRead, the one ancestor srt does not re-deny under', async () => {
    // BST-1071. The ancestor rule above holds because srt re-emits the nested
    // deny after the broader allow — but through 0.0.75 that re-emission tests
    // `denied.startsWith(allowed + '/')`, which for the root compares against
    // '//' and never matches (re-measured at 0.0.75 in BST-1669; unchanged
    // from 0.0.73, whose emission line is byte-identical).
    // Measured on macOS: `allowRead: ['/']` made ~/.ssh/* and
    // ~/.config/gh/hosts.yml readable from sandboxed code. Linux
    // was unaffected, so this refusal has to live here rather than in a
    // platform branch. Proven end-to-end in
    // fence-escape-resistance.integration.spec.ts.
    await expect(
      build({ allowedDomains: [], allowRead: ['/'], allowWrite: [] })
    ).rejects.toBeInstanceOf(FencePolicyError);
    await expect(build({ allowedDomains: [], allowRead: ['/'], allowWrite: [] })).rejects.toThrow(
      /filesystem root/
    );
  });

  it('REJECTS an allowWrite at or under an always-denied store — a write bind re-opens the READ', async () => {
    // BST-1071 review finding. bubblewrap masks a denied directory with
    // `--tmpfs`, then re-binds allowed write paths at or under it with a
    // read-WRITE `--bind`, and no write bind is unreadable — so a write grant
    // here would hand back the store the always-deny list exists to keep out.
    // macOS keeps write and read authority separate; refusing in the policy
    // layer is what stops the guarantee from depending on the platform.
    await expect(
      build({ allowedDomains: [], allowWrite: [join(homedir(), '.ssh')] })
    ).rejects.toBeInstanceOf(FencePolicyError);
    await expect(
      build({ allowedDomains: [], allowWrite: [join(homedir(), '.aws', 'nested')] })
    ).rejects.toThrow(/always-denied credential store/);
  });

  it('REJECTS a policy that allows and denies EXACTLY the same path', async () => {
    // srt re-emits a nested deny when `denied.startsWith(allowed + '/')`, which
    // is false when the two are equal — the allow wins and the deny is dropped
    // silently. A policy that does not mean what it says is refused.
    await expect(
      build({
        allowedDomains: [],
        allowRead: ['/opt/data'],
        allowWrite: [],
        denyRead: ['/opt/data'],
      })
    ).rejects.toThrow(/denyRead/);
  });

  it('still allows a denyRead NESTED inside an allowRead — srt re-emits that one', async () => {
    const config = await build({
      allowedDomains: [],
      allowRead: ['/opt/data'],
      allowWrite: [],
      denyRead: ['/opt/data/secret'],
    });
    expect(config.filesystem.denyRead).toContain('/opt/data/secret');
  });

  it('still allows an allowRead one level BELOW the root', async () => {
    // The refusal is the root specifically, not "broad grants" in general —
    // every ancestor short of it re-emits the nested deny correctly.
    await expect(
      build({ allowedDomains: [], allowRead: ['/opt'], allowWrite: [] })
    ).resolves.toBeDefined();
  });

  it('catches a re-open that only a RESOLVED path reveals (symlink into the store)', async () => {
    // The written path is innocent; realpath is what exposes it. A textual
    // comparison would have permitted this.
    const decoy = '/opt/looks-innocent';
    await expect(
      build(
        { allowedDomains: [], allowRead: [decoy], allowWrite: [] },
        scratchDir,
        fakeResolver({ links: { [decoy]: join(homedir(), '.ssh') } })
      )
    ).rejects.toBeInstanceOf(FencePolicyError);
  });

  it('catches a case-variant re-open when the VOLUME is case-insensitive, via realpath', async () => {
    // A case-insensitive volume resolves ~/.SSH to the canonical ~/.ssh. No
    // platform sniffing: case sensitivity is a filesystem property, and APFS
    // can be formatted either way.
    const variant = join(homedir(), '.SSH');
    await expect(
      build(
        { allowedDomains: [], allowRead: [variant], allowWrite: [] },
        scratchDir,
        fakeResolver({ links: { [variant]: join(homedir(), '.ssh') } })
      )
    ).rejects.toBeInstanceOf(FencePolicyError);
  });

  it('keeps a case variant DISTINCT when the volume is case-sensitive', async () => {
    // Same input, case-sensitive volume: ~/.SSH really is a different
    // directory, so permitting it is correct. Folding case would have produced
    // a false reject here and a false PERMIT in the mirror case above.
    await expect(
      build({ allowedDomains: [], allowRead: [join(homedir(), '.SSH')], allowWrite: [] })
    ).resolves.toBeDefined();
  });

  it('rejects a GLOB in allowRead — srt would expand it past the containment guard', async () => {
    // ~/.config/* is not at-or-under ~/.config/gcloud, so a literal comparison
    // passes it; srt then expands it right back over the denied store.
    await expect(
      build({ allowedDomains: [], allowRead: [join(homedir(), '.config', '*')], allowWrite: [] })
    ).rejects.toBeInstanceOf(FencePolicyError);
    await expect(
      build({ allowedDomains: [], allowRead: [join(homedir(), '.s*')], allowWrite: [] })
    ).rejects.toBeInstanceOf(FencePolicyError);
  });

  // The seam's `policyPathSchema` now rejects relative / `..` / `~` entries
  // before this module sees them, so these assert only that the request is
  // refused — by whichever layer gets there first. The equivalent checks are
  // kept in `assertPolicyPathShape` deliberately: this module hands paths to a
  // security boundary and should assert its own preconditions rather than
  // assume an upstream validator ran.
  it.each(['allowWrite', 'allowRead', 'denyRead'] as const)(
    'rejects a relative %s entry rather than letting srt resolve it against this process cwd',
    async (field) => {
      await expect(
        build({ allowedDomains: [], allowWrite: [], [field]: ['../out'] })
      ).rejects.toThrow();
    }
  );

  it('rejects a .. segment so the written policy and the effective policy agree', async () => {
    await expect(
      // Written as a raw string: path.join would collapse the `..` itself.
      build({ allowedDomains: [], allowWrite: [`${homedir()}/a/../b`] })
    ).rejects.toThrow();
  });

  it('REJECTS a home-relative path instead of expanding it', async () => {
    // srt resolves against its own process context, so a tilde that reached it
    // unexpanded would be a rule that silently grants or protects nothing.
    await expect(build({ allowedDomains: [], allowWrite: ['~/projects/out'] })).rejects.toThrow();
    await expect(build({ allowedDomains: [], allowWrite: ['~'] })).rejects.toThrow();
  });

  it('rejects an allowWrite entry that does not exist rather than guessing what it grants', async () => {
    let caught: unknown;
    try {
      await build(
        { allowedDomains: [], allowWrite: ['/opt/not-created-yet'] },
        scratchDir,
        fakeResolver({ missing: ['/opt/not-created-yet'] })
      );
    } catch (error) {
      caught = error;
    }
    expect(isFencePolicyError(caught)).toBe(true);
    if (!isFencePolicyError(caught)) {
      throw new Error('unreachable');
    }
    expect(caught.message).toMatch(/no canonical form/);
  });

  it('rejects a scratchDir that does not exist', async () => {
    await expect(
      build(
        { allowedDomains: [], allowWrite: [] },
        scratchDir,
        fakeResolver({ missing: [scratchDir] })
      )
    ).rejects.toBeInstanceOf(FencePolicyError);
  });

  it('tolerates an absent DENY path — a host without that store is not an error', async () => {
    // Deny rules are the one place absence is normal: most hosts lack several
    // of the always-denied stores. The literal still reaches srt.
    const config = await build(
      { allowedDomains: [], allowWrite: [], denyRead: ['/opt/never-existed'] },
      scratchDir,
      fakeResolver({ missing: ['/opt/never-existed', ...ALWAYS_DENY_READ_PATHS] })
    );
    expect(config.filesystem.denyRead).toEqual([...ALWAYS_DENY_READ_PATHS, '/opt/never-existed']);
  });

  it('rejects a relative scratch dir instead of resolving it against an implicit cwd', async () => {
    await expect(
      build({ allowedDomains: [], allowWrite: [] }, 'relative/scratch')
    ).rejects.toBeInstanceOf(FencePolicyError);
  });

  it('re-validates the policy strictly at the sandbox boundary', async () => {
    await expect(
      // A caller that bypassed the seam's schema must still be rejected here.
      build({ allowedDomains: [], allowNetwork: true, allowWrite: [] } as never)
    ).rejects.toThrow();
    await expect(build({ allowedDomains: [] } as never)).rejects.toThrow();
  });
});
