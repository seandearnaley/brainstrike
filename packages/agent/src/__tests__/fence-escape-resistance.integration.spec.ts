/**
 * Fence escape-resistance suite — the red team (BST-1071).
 *
 * `fence-executor.integration.spec.ts` proves the FenceExecutor's CONTRACT:
 * code runs, exit codes propagate, the obvious denials deny. This suite is the
 * adversary. It assumes the contract holds and goes looking for the ways out —
 * traversal, symlinks, forks, detached descendants, raw sockets that ignore the
 * proxy, policies crafted to re-open what the fence always denies — and it
 * pins, in executable form, the things the fence does NOT stop.
 *
 * Read `fence-escape-resistance.README.md` next to this file before changing
 * anything here. It carries the guarantee/non-guarantee split, the
 * mutation-kill table (which weakening of the mechanism turns which test red),
 * and the reason this suite is tied to an EXACT srt version.
 *
 * Rules this suite holds itself to:
 *
 * - **No test may pass for the wrong reason.** Every denial assertion is
 *   paired with a positive control proving the same operation SUCCEEDS when
 *   the fence permits it, or proving the resource was reachable unsandboxed.
 *   "Blocked" and "was never possible here" are not the same result, and a
 *   security test that cannot tell them apart is decoration.
 * - **No wall-clock-tight assertions.** The machine this runs on is loaded. A
 *   timeout test asserts that the kill HAPPENED and what shape it left behind,
 *   never that it happened within N milliseconds. A flaky security test gets
 *   disabled, and a disabled security test is worse than none.
 * - **Skips are loud and specific**, never a silently weakened assertion.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { platform } from 'node:process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type CodeExecutor,
  type ExecPolicy,
  type ExecResult,
  isExecAbortedError,
  isExecResultTruncated,
} from '../code-execution';
import { createFenceExecutor, INHERITED_ENV_VARS } from '../fence/fence-executor';
import { isFencePolicyError } from '../fence/fence-policy';
import {
  describeFenceHostSkipReason,
  refuseToSkipInAPromisedLane,
} from './fixtures/fence-host-gate';

/**
 * The srt version this suite is proven against.
 *
 * srt is a fast-moving research preview and the escapes this suite chases live
 * in ITS profile generation, not ours — the root-wide-allowRead hole below was
 * an off-by-one in how srt 0.0.67 re-emits nested denies, and it is STILL
 * present at 0.0.75. The load-bearing evidence for that is the live run below,
 * not source reading: 0.0.75 rewrote macOS deny emission around this logic
 * (folding literal denies into regexes), so line-level identity of the
 * re-emission test corroborates the result but cannot establish it on its own.
 * A bump can silently change any of this, which is why the pin is asserted as a
 * test: bumping srt REQUIRES re-greening this suite, not just the type-check.
 */
const PINNED_SRT_VERSION = '0.0.75';

/** Per-request output cap; small enough to overflow without minutes of I/O. */
const MAX_OUTPUT_BYTES = 256 * 1024;

/** Generous default; individual cases pass their own where they need less. */
const DEFAULT_TIMEOUT_MS = 25_000;

/**
 * Environment keys the OS or the wrapping shell re-adds inside the fence with
 * the same value the host happens to have. They are NOT inherited by us —
 * `sandbox-exec`/`sh` set them on the far side — so the "no host env crosses
 * the fence" assertion has to name them explicitly rather than pretend they
 * are a leak. Every one of them is a shell/CoreFoundation bookkeeping variable
 * that carries no secret.
 */
const OS_READDED_ENV_KEYS: readonly string[] = [
  '__CF_USER_TEXT_ENCODING',
  '_',
  'OLDPWD',
  'PWD',
  'SHLVL',
];

const PROBE_URL = 'https://example.com';
const PROBE_HOST = 'example.com';
/**
 * A host the allow-list test deliberately does NOT name.
 *
 * It must return a real 200 UNSANDBOXED, which is why it is not `example.org`:
 * that host answers 403 to python's default user agent from some networks, and
 * `urlopen` raises on a 403 exactly like it raises on a refused proxy tunnel.
 * An earlier revision of this suite used it and passed while the allow-list was
 * mutated wide open — the deny it was "proving" was an upstream 403. The
 * reachability gate below plus the HTTPError/URLError split in the test are the
 * two guards that stop that from recurring.
 */
const OFF_LIST_URL = 'https://www.iana.org';

const require_ = createRequire(import.meta.url);

function installedSrtVersion(): string {
  let dir = dirname(require_.resolve('@anthropic-ai/sandbox-runtime'));
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === '@anthropic-ai/sandbox-runtime' && pkg.version) {
        return pkg.version;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error('could not locate the installed @anthropic-ai/sandbox-runtime package.json');
}

function resolvePython(): string | undefined {
  for (const candidate of ['python3', 'python']) {
    try {
      const resolved = execFileSync(platform === 'win32' ? 'where' : 'which', [candidate], {
        encoding: 'utf8',
      })
        .split('\n')[0]
        ?.trim();
      if (resolved && existsSync(resolved)) {
        return resolved;
      }
    } catch {
      // Not on PATH — try the next candidate.
    }
  }
  return;
}

const pythonPath = resolvePython();

/**
 * Runs a snippet through the SAME interpreter with NO fence at all.
 *
 * This is the positive control the network cases are built on. Every raw-socket
 * denial below is meaningless unless the identical call succeeds unsandboxed:
 * on a host with no egress, "the fence blocked it" and "nothing could have
 * reached it" produce byte-identical output.
 */
function runUnsandboxed(code: string): { ok: boolean; output: string } {
  try {
    return {
      ok: true,
      output: execFileSync(pythonPath as string, ['-c', code], {
        encoding: 'utf8',
        timeout: 30_000,
      }),
    };
  } catch (error) {
    // KEEP the partial stdout. `execFileSync` throws on any non-zero exit, and
    // python exits on the FIRST failing precondition — so without the output it
    // already produced, a probe that got two checks in before failing the third
    // is indistinguishable from one that failed the first. That is how a skip
    // ends up naming the wrong cause and sending a reader after the one thing
    // that was working.
    const stdout = (error as { stdout?: unknown }).stdout;
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      output: `${typeof stdout === 'string' ? stdout : ''}\n${message}`,
    };
  }
}

/**
 * Everything the network cases need to be attributable to the fence, checked
 * with NO fence in the way:
 *
 * - a raw socket to the probe host, or the raw-socket denials below prove only
 *   that this machine has no egress;
 * - a 200 from the allow-listed URL, or the positive control cannot fire;
 * - a 200 from the OFF-LIST URL, or "blocked" inside the fence is
 *   indistinguishable from a host that was answering 403 all along.
 */
const NETWORK_PRECONDITION_PROBE = [
  'import socket, urllib.request',
  `s = socket.create_connection((${JSON.stringify(PROBE_HOST)}, 443), timeout=10)`,
  's.close()',
  'print("RAW-OK")',
  `print("ALLOWED-STATUS", urllib.request.urlopen(${JSON.stringify(PROBE_URL)}, timeout=20).status)`,
  `print("OFFLIST-STATUS", urllib.request.urlopen(${JSON.stringify(OFF_LIST_URL)}, timeout=20).status)`,
].join('\n');

async function describeHostSkipReason(): Promise<string | undefined> {
  const hostReason = await describeFenceHostSkipReason();
  if (hostReason) {
    return hostReason;
  }
  if (!pythonPath) {
    return 'no python3/python interpreter is on PATH';
  }
  return;
}

/**
 * Gates ONLY the network cases. Splitting this out of the host gate is
 * deliberate: an offline host must still get the filesystem, process-tree,
 * environment and teardown proofs rather than skipping the whole suite.
 */
function describeNetworkSkipReason(): string | undefined {
  const probe = runUnsandboxed(NETWORK_PRECONDITION_PROBE);
  const detail = probe.output.trim().slice(0, 200);
  // Each marker is checked INDEPENDENTLY against whatever the probe managed to
  // print, never against `probe.ok`: the probe exits non-zero on its first
  // failure, so gating every branch on the exit status would report a later
  // check's failure as the first one's. These gates decide whether security
  // tests run at all — a skip that names the wrong cause is worse than useless.
  if (!probe.output.includes('RAW-OK')) {
    return `${PROBE_HOST}:443 is not reachable by an UNSANDBOXED socket from this host, so a blocked socket inside the fence would be indistinguishable from a dead network (${detail})`;
  }
  if (!probe.output.includes('ALLOWED-STATUS 200')) {
    return `${PROBE_URL} does not return 200 UNSANDBOXED, so the allow-list positive control cannot fire (${detail})`;
  }
  if (!probe.output.includes('OFFLIST-STATUS 200')) {
    return `${OFF_LIST_URL} does not return 200 UNSANDBOXED, so a "blocked" result inside the fence could not be attributed to the allow-list (${detail})`;
  }
  return;
}

// Both gates route through the shared escalation, and BOTH matter: in a lane
// that declared BRAINSTRIKE_FENCE_DEPS_REQUIRED, quietly dropping the egress
// proofs (raw sockets, DNS, the allow-list) is the same broken promise as
// dropping the whole suite — the lane would report green having never exercised
// the network boundary. Everywhere else they stay warn-and-skip, so an offline
// laptop still gets the filesystem, policy and process-tree proofs.
const hostSkipReason = refuseToSkipInAPromisedLane(
  'fence-escape-resistance',
  await describeHostSkipReason()
);
if (hostSkipReason) {
  console.warn(`[fence-escape-resistance] SUITE SKIPPED — ${hostSkipReason}`);
}
const networkSkipReason =
  hostSkipReason ??
  refuseToSkipInAPromisedLane('fence-escape-resistance network cases', describeNetworkSkipReason());
if (!hostSkipReason && networkSkipReason) {
  console.warn(`[fence-escape-resistance] NETWORK CASES SKIPPED — ${networkSkipReason}`);
}

const NO_NETWORK: Omit<ExecPolicy, 'allowWrite'> = { allowedDomains: [] };

describe.skipIf(hostSkipReason !== undefined)('FenceExecutor escape resistance', () => {
  let executor: CodeExecutor;
  /** The run's working directory; the only place writes are granted. */
  let scratchDir: string;
  /** A sibling directory the run must never be able to touch. */
  let outsideDir: string;
  /** Holds a `vault` subdirectory the policy denies and an `open` one it does not. */
  let secretsRoot: string;
  let vaultDir: string;
  let openDir: string;

  const VAULT_CANARY = 'bst-1071-vault-canary-must-not-be-read';
  const OPEN_CANARY = 'bst-1071-open-canary-is-readable';
  const DOTENV_CANARY = 'bst-1071-dotenv-canary';

  beforeAll(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'bst-redteam-scratch-'));
    outsideDir = mkdtempSync(join(tmpdir(), 'bst-redteam-outside-'));
    secretsRoot = mkdtempSync(join(tmpdir(), 'bst-redteam-secrets-'));
    vaultDir = join(secretsRoot, 'vault');
    openDir = join(secretsRoot, 'open');
    mkdirSync(vaultDir);
    mkdirSync(openDir);
    writeFileSync(join(vaultDir, 'credentials'), VAULT_CANARY);
    writeFileSync(join(openDir, 'notes.txt'), OPEN_CANARY);
    writeFileSync(join(outsideDir, '.env'), `SECRET=${DOTENV_CANARY}`);
    // Symlinks planted INSIDE scratch that point out of it. The sandboxed code
    // only ever sees paths under scratchDir; the fence has to resolve them.
    symlinkSync(outsideDir, join(scratchDir, 'link-to-outside'));
    symlinkSync(vaultDir, join(scratchDir, 'link-to-vault'));
    mkdirSync(join(scratchDir, 'nested'));
    symlinkSync(join(scratchDir, 'nested'), join(scratchDir, 'link-to-inside'));

    executor = createFenceExecutor({
      interpreters: { python: { command: pythonPath as string, scriptExtension: 'py' } },
    });
  });

  afterAll(async () => {
    await executor.dispose();
    for (const dir of [scratchDir, outsideDir, secretsRoot]) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  const run = (
    code: string,
    overrides: Partial<ExecPolicy> = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal: AbortSignal = new AbortController().signal
  ) =>
    executor.execute({
      code,
      language: 'python',
      maxOutputBytes: MAX_OUTPUT_BYTES,
      policy: { ...NO_NETWORK, allowWrite: [scratchDir], ...overrides },
      scratchDir,
      signal,
      timeoutMs,
    });

  /**
   * Python that reports whether a read succeeded, without dying on failure.
   * `pathExpr` is python SOURCE, so a case can hand in a computed path.
   */
  const tryReadExpr = (pathExpr: string, tag: string): string =>
    [
      'try:',
      `    print(${JSON.stringify(tag)}, open(${pathExpr}).read()[:120])`,
      'except Exception as e:',
      `    print(${JSON.stringify(`${tag}-DENIED`)}, type(e).__name__)`,
    ].join('\n');

  const tryRead = (path: string, tag: string): string => tryReadExpr(JSON.stringify(path), tag);

  /** Python that reports whether a write succeeded, without dying on failure. */
  const tryWriteExpr = (pathExpr: string, tag: string): string =>
    [
      'try:',
      `    open(${pathExpr}, "w").write("pwned")`,
      `    print(${JSON.stringify(`${tag}-WROTE`)})`,
      'except Exception as e:',
      `    print(${JSON.stringify(`${tag}-DENIED`)}, type(e).__name__)`,
    ].join('\n');

  const tryWrite = (path: string, tag: string): string => tryWriteExpr(JSON.stringify(path), tag);

  /** Re-indents a generated block so it can sit inside a python suite. */
  const indent = (block: string): string[] => block.split('\n').map((line) => `    ${line}`);

  // -------------------------------------------------------------------------
  // Filesystem containment
  // -------------------------------------------------------------------------

  describe('filesystem containment', () => {
    it('DENIES a write that traverses out of scratchDir with "..", while the same traversal back INTO scratchDir succeeds', async () => {
      const escapeTarget = join(outsideDir, 'traversal-escape.txt');
      rmSync(escapeTarget, { force: true });
      const result = await run(
        [
          'import os',
          `escape = os.path.join(${JSON.stringify(scratchDir)}, "..", ${JSON.stringify(basename(outsideDir))}, "traversal-escape.txt")`,
          `control = os.path.join(${JSON.stringify(scratchDir)}, "..", ${JSON.stringify(basename(scratchDir))}, "traversal-control.txt")`,
          tryWriteExpr('escape', 'ESCAPE'),
          tryWriteExpr('control', 'CONTROL'),
        ].join('\n')
      );

      expect(result.stdout).toContain('ESCAPE-DENIED');
      expect(result.stdout).not.toContain('ESCAPE-WROTE');
      expect(existsSync(escapeTarget)).toBe(false);
      // The control proves the `..` FORM is not what failed: the identical
      // construction that lands back inside scratchDir is written normally.
      expect(result.stdout).toContain('CONTROL-WROTE');
      expect(existsSync(join(scratchDir, 'traversal-control.txt'))).toBe(true);
    });

    it('DENIES a write through a symlink that leaves scratchDir, while a symlink that stays inside works', async () => {
      const escapeTarget = join(outsideDir, 'symlink-escape.txt');
      rmSync(escapeTarget, { force: true });
      const result = await run(
        [
          tryWrite(join(scratchDir, 'link-to-outside', 'symlink-escape.txt'), 'ESCAPE'),
          tryWrite(join(scratchDir, 'link-to-inside', 'symlink-control.txt'), 'CONTROL'),
        ].join('\n')
      );

      expect(result.stdout).toContain('ESCAPE-DENIED');
      expect(result.stdout).not.toContain('ESCAPE-WROTE');
      expect(existsSync(escapeTarget)).toBe(false);
      // Containment resolves the link rather than banning links: a symlink
      // whose target is inside scratchDir is still writable.
      expect(result.stdout).toContain('CONTROL-WROTE');
      expect(existsSync(join(scratchDir, 'nested', 'symlink-control.txt'))).toBe(true);
    });

    it('DENIES a read through a symlink into a denied store, while the sibling allowed store reads fine', async () => {
      const result = await run(
        [
          tryRead(join(scratchDir, 'link-to-vault', 'credentials'), 'VAULT'),
          tryRead(join(openDir, 'notes.txt'), 'OPEN'),
        ].join('\n'),
        { denyRead: [vaultDir] }
      );

      expect(result.stdout).toContain('VAULT-DENIED');
      expect(result.stdout).not.toContain(VAULT_CANARY);
      // Same shape of read, one directory over, permitted: the denial is the
      // deny rule doing its job, not the symlink or the read failing generally.
      expect(result.stdout).toContain(OPEN_CANARY);
    });

    it('keeps a denyRead child denied underneath an allowRead of its parent', async () => {
      // srt documents allowRead as taking precedence over denyRead. The nested
      // deny survives only because srt RE-EMITS it after the broader allow —
      // the exact mechanism that fails at the filesystem root (see the policy
      // containment case below). This pins the behaviour we depend on.
      const result = await run(
        [
          tryRead(join(vaultDir, 'credentials'), 'VAULT'),
          tryRead(join(openDir, 'notes.txt'), 'OPEN'),
        ].join('\n'),
        { allowRead: [secretsRoot], denyRead: [vaultDir] }
      );

      expect(result.stdout).toContain('VAULT-DENIED');
      expect(result.stdout).not.toContain(VAULT_CANARY);
      expect(result.stdout).toContain(OPEN_CANARY);
    });

    it('DENIES reading a .env the policy names in denyRead', async () => {
      const dotenv = join(outsideDir, '.env');
      const result = await run(tryRead(dotenv, 'DOTENV'), { denyRead: [dotenv] });

      expect(result.stdout).toContain('DOTENV-DENIED');
      expect(result.stdout).not.toContain(DOTENV_CANARY);
    });

    it('PERMITS reading that same .env when the policy does not deny it — the fence is not a read jail', async () => {
      // NOT a bug, and deliberately asserted rather than left implicit: srt's
      // read model is deny-then-allow ("read access is allowed everywhere" by
      // default), so the ONLY reads a run cannot perform are the always-denied
      // credential stores plus whatever `denyRead` names. Callers that need a
      // read jail must build the deny list; the fence will not infer it. If a
      // future srt flips this default, this test goes red and the README's
      // non-guarantee list needs rewriting — which is the point.
      const dotenv = join(outsideDir, '.env');
      const result = await run(tryRead(dotenv, 'DOTENV'));

      expect(result.stdout).toContain(DOTENV_CANARY);
    });

    it('DENIES the always-denied credential stores even with the widest allowRead the policy permits', async () => {
      const home = homedir();
      const populated = ['.ssh', '.aws', '.gnupg', '.config/gcloud', '.config/gh', '.kube'].filter(
        (relative) => {
          const target = join(home, relative);
          try {
            return existsSync(target) && readdirSync(target).length > 0;
          } catch {
            return false;
          }
        }
      );

      const result = await run(
        [
          'import glob, os',
          ...populated.map(
            (relative) =>
              `print("STORE", ${JSON.stringify(relative)}, glob.glob(os.path.join(os.path.expanduser("~"), ${JSON.stringify(relative)}, "*"))[:5])`
          ),
          // The interpreter still has to be able to read SOMETHING, or an
          // all-denied result would look identical to a broken run.
          `print("CONTROL", os.path.isdir(${JSON.stringify(scratchDir)}))`,
        ].join('\n'),
        // $HOME is the widest allowRead `buildSandboxRuntimeConfig` still
        // accepts — the root is refused outright, see the policy case below.
        { allowRead: [home] }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('CONTROL True');
      for (const relative of populated) {
        // `print` renders a str argument bare, so an empty glob reads as
        // "STORE .ssh []" — the store exists and has entries on this host, and
        // the sandboxed process still cannot see a single one of them.
        expect(result.stdout).toContain(`STORE ${relative} []`);
      }
      if (populated.length === 0) {
        console.warn(
          '[fence-escape-resistance] no populated credential store exists on this host, so the always-deny assertion had nothing to prove against.'
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // Policy containment — refused before anything spawns
  // -------------------------------------------------------------------------

  describe('policy containment', () => {
    /** Proves the rejection happened BEFORE a process ran. */
    const markerCode = (marker: string): string =>
      `open(${JSON.stringify(marker)}, "w").write("ran")`;

    const expectRefused = async (
      overrides: Partial<ExecPolicy>,
      markerName: string
    ): Promise<Error> => {
      const marker = join(scratchDir, markerName);
      rmSync(marker, { force: true });
      let caught: unknown;
      try {
        await run(markerCode(marker), overrides);
      } catch (error) {
        caught = error;
      }
      expect(isFencePolicyError(caught)).toBe(true);
      // Refusal is not enough: nothing may have executed on the way to it.
      expect(existsSync(marker)).toBe(false);
      return caught as Error;
    };

    it('REFUSES a glob allowRead that srt would expand over a denied store', async () => {
      const error = await expectRefused(
        { allowRead: [join(homedir(), '.config', '*')] },
        'glob-config-marker.txt'
      );
      expect(error.message).toContain('glob');
    });

    it('REFUSES a glob allowRead whose prefix reaches .ssh', async () => {
      const error = await expectRefused({ allowRead: [join(homedir(), '.s*')] }, 'glob-ssh-marker');
      expect(error.message).toContain('glob');
    });

    it('REFUSES a root-wide allowRead, which srt 0.0.75 does not re-deny under (macOS)', async () => {
      // BST-1071's live finding, re-measured against 0.0.73 in BST-1285 and
      // against 0.0.75 in BST-1669, where this test passing IS the measurement:
      // the hole is STILL PRESENT. srt re-applies a nested deny on top of a broader
      // allowRead by testing `denied.startsWith(allowed + "/")`; for
      // `allowed === "/"` that compares against "//" and never matches, so on
      // macOS `allowRead: ['/']` made ~/.ssh and ~/.config/gh readable. Linux
      // masks denied directories with tmpfs and was unaffected — which is
      // exactly why the refusal lives in our policy layer and not in a
      // platform check. Removing the guard turns this red on macOS and leaves
      // it green on Linux; that asymmetry is documented in the README.
      const error = await expectRefused({ allowRead: ['/'] }, 'root-allowread-marker.txt');
      expect(error.message).toContain('filesystem root');
    });

    it('REFUSES an allowWrite on an always-denied store — a write bind re-opens it for READING on Linux', async () => {
      // The mirror image of the root-allowRead finding, and the reason it is
      // refused rather than left to the platform. bubblewrap masks a denied
      // directory with `--tmpfs`, then re-binds every allowed write path at or
      // under it with a read-WRITE `--bind`; there is no write bind you cannot
      // read, so `allowWrite: ['~/.ssh']` hands back the store the always-deny
      // list exists to keep out. macOS keeps write and read authority separate
      // and would NOT leak — so on this platform the refusal is what makes the
      // guarantee platform-independent rather than what makes it true.
      const sshDir = join(homedir(), '.ssh');
      const error = await expectRefused(
        { allowWrite: [scratchDir, sshDir] },
        'ssh-allowwrite-marker.txt'
      );
      if (existsSync(sshDir)) {
        expect(error.message).toContain('always-denied credential store');
      } else {
        console.warn(
          '[fence-escape-resistance] ~/.ssh does not exist on this host, so the allowWrite containment refusal was proven only as "refused".'
        );
      }
    });

    it('REFUSES a policy that both allows and denies the SAME path, instead of silently dropping the deny', async () => {
      // The same off-by-one as the root case, one row over. srt keeps a nested
      // deny alive by re-emitting it when `denied.startsWith(allowed + '/')` —
      // false when the two are EQUAL. So `allowRead: [X], denyRead: [X]` lets
      // the last-match-wins allow stand and discards the deny without a word.
      // The caller wrote a contradiction; they get an error, not a coin flip.
      const error = await expectRefused(
        { allowRead: [vaultDir], denyRead: [vaultDir] },
        'collision-marker.txt'
      );
      expect(error.message).toContain('denyRead');
    });

    it('still permits a denyRead NESTED inside an allowRead — the supported shape', async () => {
      // The positive control for the refusal above: srt DOES re-emit a deny
      // that is strictly under the allow, so that policy is honoured and stays
      // legal. Refusing the exact collision must not swallow this case too.
      const result = await run(
        [
          tryRead(join(vaultDir, 'credentials'), 'VAULT'),
          tryRead(join(openDir, 'notes.txt'), 'OPEN'),
        ].join('\n'),
        { allowRead: [secretsRoot], denyRead: [vaultDir] }
      );
      expect(result.stdout).toContain('VAULT-DENIED');
      expect(result.stdout).toContain(OPEN_CANARY);
    });

    it('REFUSES an allowRead that sits directly on an always-denied store', async () => {
      const sshDir = join(homedir(), '.ssh');
      const error = await expectRefused({ allowRead: [sshDir] }, 'ssh-allowread-marker.txt');
      if (existsSync(sshDir)) {
        expect(error.message).toContain('always-denied credential store');
      } else {
        // Still refused, but by the nonexistent-path rule rather than by
        // containment. Say so instead of asserting a message we did not earn.
        console.warn(
          '[fence-escape-resistance] ~/.ssh does not exist on this host, so the allowRead containment refusal was proven only as "refused", not as "refused for re-opening a store".'
        );
      }
    });

    it('ACCEPTS the same policy shape once the offending entry is a real directory that is not a store', async () => {
      // The positive control for this whole group: the refusals above are
      // specific rules, not a policy layer that rejects allowRead in general.
      const result = await run(tryRead(join(openDir, 'notes.txt'), 'OPEN'), {
        allowRead: [openDir],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(OPEN_CANARY);
    });
  });

  // -------------------------------------------------------------------------
  // Network egress
  // -------------------------------------------------------------------------

  describe.skipIf(networkSkipReason !== undefined)('network egress', () => {
    it('DENIES a raw socket that ignores the proxy environment, with allowedDomains empty', async () => {
      const result = await run(
        [
          'import os, socket',
          // Printed so the assertion below is not vacuous: the proxy variables
          // ARE in this environment, and the raw socket is deliberately not
          // using them. The block therefore comes from the OS fence, not from
          // an unconfigured client.
          'print("PROXY", bool(os.environ.get("HTTPS_PROXY")))',
          'try:',
          `    socket.create_connection((${JSON.stringify(PROBE_HOST)}, 443), timeout=10)`,
          '    print("RAW-CONNECTED")',
          'except Exception as e:',
          '    print("RAW-BLOCKED", type(e).__name__)',
        ].join('\n')
      );

      expect(result.stdout).toContain('PROXY True');
      expect(result.stdout).toContain('RAW-BLOCKED');
      expect(result.stdout).not.toContain('RAW-CONNECTED');
    });

    it('DENIES that same raw socket even when the domain IS on the allow-list — the allow-list is proxy-only', async () => {
      // A property worth pinning rather than discovering later: srt's
      // allow-list is enforced at its HTTP/SOCKS proxy, and the OS fence
      // blocks direct egress outright. Allow-listing a domain does not hand
      // back a raw socket to it. Anything speaking a non-proxied protocol gets
      // nothing, allow-listed or not.
      const result = await run(
        [
          'import socket',
          'try:',
          `    socket.create_connection((${JSON.stringify(PROBE_HOST)}, 443), timeout=10)`,
          '    print("RAW-CONNECTED")',
          'except Exception as e:',
          '    print("RAW-BLOCKED", type(e).__name__)',
        ].join('\n'),
        { allowedDomains: [PROBE_HOST] }
      );

      expect(result.stdout).toContain('RAW-BLOCKED');
      expect(result.stdout).not.toContain('RAW-CONNECTED');
    });

    it('gives the sandboxed process NO resolver at all, closing DNS as an exfiltration channel', async () => {
      // Encoding data into a hostname and resolving it leaks without ever
      // completing a connection, so a connect-only guard would miss it. What
      // shuts that channel is stronger and simpler than a name filter: the
      // sandboxed process cannot resolve ANY name, because resolution happens
      // proxy-side. Both hosts below are ones the suite has already proven
      // resolve UNSANDBOXED (the precondition probe fetched both), so a
      // gaierror here is the fence and not an unregistered name.
      //
      // Deliberately NOT asserted with a made-up `<canary>.example.org` label:
      // that returns NXDOMAIN — the very same gaierror — with no fence in
      // sight, which would be a test that passes for the wrong reason.
      const result = await run(
        [
          'import socket',
          `for host in (${JSON.stringify(PROBE_HOST)}, ${JSON.stringify(new URL(OFF_LIST_URL).hostname)}):`,
          '    try:',
          '        socket.getaddrinfo(host, 80)',
          '        print("DNS-RESOLVED", host)',
          '    except Exception as e:',
          '        print("DNS-BLOCKED", host, type(e).__name__)',
        ].join('\n'),
        // Even with the domain ALLOW-LISTED, no resolver is handed over.
        { allowedDomains: [PROBE_HOST] }
      );

      expect(result.stdout).not.toContain('DNS-RESOLVED');
      expect(result.stdout).toContain(`DNS-BLOCKED ${PROBE_HOST}`);
      expect(result.stdout).toContain(`DNS-BLOCKED ${new URL(OFF_LIST_URL).hostname}`);
    });

    it('DENIES a non-allow-listed host while the allow-listed one succeeds in the SAME run', async () => {
      // Both halves in one execution, so the deny cannot be blamed on a
      // transient network fault: the 200 proves egress worked at that instant.
      //
      // The HTTPError branch is load-bearing, not tidiness. `urlopen` raises
      // for an upstream 4xx exactly as it raises for a proxy that refused the
      // CONNECT, so a bare `except Exception` reports "blocked" for a host that
      // was reached and answered 403. Splitting them means only a genuine
      // tunnel refusal can satisfy the assertion below.
      const result = await run(
        [
          'import urllib.error, urllib.request',
          `for url in (${JSON.stringify(PROBE_URL)}, ${JSON.stringify(OFF_LIST_URL)}):`,
          '    try:',
          '        r = urllib.request.urlopen(url, timeout=20)',
          '        print("REACHED", url, r.status)',
          '    except urllib.error.HTTPError as e:',
          '        print("UPSTREAM-ANSWERED", url, e.code)',
          '    except Exception as e:',
          '        print("TUNNEL-REFUSED", url, type(e).__name__)',
        ].join('\n'),
        { allowedDomains: [PROBE_HOST] }
      );

      expect(result.stdout).toContain(`REACHED ${PROBE_URL} 200`);
      expect(result.stdout).toContain(`TUNNEL-REFUSED ${OFF_LIST_URL}`);
      expect(result.stdout).not.toContain(`REACHED ${OFF_LIST_URL}`);
      // The off-list host never got to answer at all — if it had, the request
      // left the fence and the allow-list did nothing.
      expect(result.stdout).not.toContain(`UPSTREAM-ANSWERED ${OFF_LIST_URL}`);
    });
  });

  // -------------------------------------------------------------------------
  // Process-tree inheritance — srt's key property
  // -------------------------------------------------------------------------

  describe('process-tree inheritance', () => {
    it('DENIES an os.fork() child a write outside scratchDir, while the same fork writes inside it', async () => {
      const escapeTarget = join(outsideDir, 'fork-escape.txt');
      const controlTarget = join(scratchDir, 'fork-control.txt');
      rmSync(escapeTarget, { force: true });
      rmSync(controlTarget, { force: true });

      const result = await run(
        [
          'import os, sys',
          'pid = os.fork()',
          'if pid == 0:',
          ...indent(tryWrite(escapeTarget, 'FORK-ESCAPE')),
          ...indent(tryWrite(controlTarget, 'FORK-CONTROL')),
          // os._exit skips interpreter shutdown, which would otherwise discard
          // this child's buffered stdout and make the whole case vacuous.
          '    sys.stdout.flush()',
          '    os._exit(0)',
          'os.waitpid(pid, 0)',
          'print("PARENT-DONE")',
        ].join('\n')
      );

      expect(result.stdout).toContain('PARENT-DONE');
      expect(result.stdout).toContain('FORK-ESCAPE-DENIED');
      expect(existsSync(escapeTarget)).toBe(false);
      // The forked child really ran and really wrote — the denial above is
      // inheritance, not a fork that never happened.
      expect(result.stdout).toContain('FORK-CONTROL-WROTE');
      expect(existsSync(controlTarget)).toBe(true);
    });

    it('DENIES a multiprocessing child a write outside scratchDir', async () => {
      const escapeTarget = join(outsideDir, 'mp-escape.txt');
      const controlTarget = join(scratchDir, 'mp-control.txt');
      rmSync(escapeTarget, { force: true });
      rmSync(controlTarget, { force: true });

      const result = await run(
        [
          'import multiprocessing as mp',
          'def child():',
          ...indent(tryWrite(escapeTarget, 'MP-ESCAPE')),
          ...indent(tryWrite(controlTarget, 'MP-CONTROL')),
          'if __name__ == "__main__":',
          '    mp.set_start_method("fork", force=True)',
          '    p = mp.Process(target=child)',
          '    p.start()',
          '    p.join()',
          '    print("MP-PARENT-DONE")',
        ].join('\n')
      );

      expect(result.stdout).toContain('MP-PARENT-DONE');
      expect(result.stdout).toContain('MP-ESCAPE-DENIED');
      expect(existsSync(escapeTarget)).toBe(false);
      expect(result.stdout).toContain('MP-CONTROL-WROTE');
      expect(existsSync(controlTarget)).toBe(true);
    });

    it('DENIES a GRANDCHILD (depth 2) a write outside scratchDir', async () => {
      // One level of subprocess is already covered by the contract suite. Two
      // levels is the interesting claim: the fence is inherited by the whole
      // subtree, not applied per-spawn by the code that did the spawning.
      const escapeTarget = join(outsideDir, 'grandchild-escape.txt');
      rmSync(escapeTarget, { force: true });

      const grandchild = tryWrite(escapeTarget, 'GC');
      const child = [
        'import subprocess, sys',
        `r = subprocess.run([sys.executable, "-c", ${JSON.stringify(grandchild)}], capture_output=True, text=True)`,
        'print(r.stdout.strip())',
      ].join('\n');

      const result = await run(
        [
          'import subprocess, sys',
          `r = subprocess.run([sys.executable, "-c", ${JSON.stringify(child)}], capture_output=True, text=True)`,
          'print("DEPTH2", r.stdout.strip())',
        ].join('\n')
      );

      expect(result.stdout).toContain('DEPTH2 GC-DENIED');
      expect(result.stdout).not.toContain('GC-WROTE');
      expect(existsSync(escapeTarget)).toBe(false);
    });

    it.skipIf(networkSkipReason !== undefined)(
      'DENIES a GRANDCHILD (depth 2) a network connection',
      async () => {
        const grandchild = [
          'import socket',
          'try:',
          `    socket.create_connection((${JSON.stringify(PROBE_HOST)}, 443), timeout=8)`,
          '    print("GC-CONNECTED")',
          'except Exception as e:',
          '    print("GC-BLOCKED", type(e).__name__)',
        ].join('\n');
        const child = [
          'import subprocess, sys',
          `r = subprocess.run([sys.executable, "-c", ${JSON.stringify(grandchild)}], capture_output=True, text=True)`,
          'print(r.stdout.strip())',
        ].join('\n');

        const result = await run(
          [
            'import subprocess, sys',
            `r = subprocess.run([sys.executable, "-c", ${JSON.stringify(child)}], capture_output=True, text=True)`,
            'print("DEPTH2", r.stdout.strip())',
          ].join('\n')
        );

        expect(result.stdout).toContain('DEPTH2 GC-BLOCKED');
        expect(result.stdout).not.toContain('GC-CONNECTED');
      }
    );
  });

  // -------------------------------------------------------------------------
  // Resource exhaustion — the timeout is the ONLY bound
  // -------------------------------------------------------------------------

  describe('resource exhaustion', () => {
    /**
     * The exact shape a timeout kill must leave behind. Asserting only "it
     * failed" would pass for a syntax error, an interpreter crash, or a
     * PermissionError — none of which prove the watchdog fired.
     */
    const expectTimeoutKillShape = (result: ExecResult): void => {
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(result.signal).not.toBeNull();
      expect(result.signal).toMatch(/^SIG[A-Z]+$/);
    };

    it('kills an infinite CPU loop on timeout and reports the exact signal shape', async () => {
      const result = await run('while True:\n    pass', {}, 3000);
      expectTimeoutKillShape(result);
      // No wall-clock bound is asserted: under load the kill can land late and
      // still be correct. What must hold is that it landed at all.
    });

    it('kills an unbounded allocation on timeout — the fence caps memory at nothing', async () => {
      // There is no memory ceiling in the fence. This test does not assert one;
      // it asserts that the ONLY thing that stops a memory hog is the request's
      // own timeout, which is a non-guarantee the README states explicitly.
      // Chunk size and cadence are chosen so a slow host cannot get far.
      const result = await run(
        [
          'import time',
          'blocks = []',
          'while True:',
          '    blocks.append(bytearray(16 * 1024 * 1024))',
          '    time.sleep(0.1)',
        ].join('\n'),
        {},
        3000
      );
      expectTimeoutKillShape(result);
    });

    it('bounds captured output rather than the producer — a firehose is truncated, not stopped', async () => {
      const result = await run(
        [
          'import sys',
          'chunk = "x" * 65536',
          `for _ in range(${Math.ceil((MAX_OUTPUT_BYTES * 3) / 65_536)}):`,
          '    sys.stdout.write(chunk)',
          'sys.stdout.flush()',
          'sys.stderr.write("done")',
        ].join('\n')
      );
      expect(isExecResultTruncated(result)).toBe(true);
      expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(MAX_OUTPUT_BYTES);
      expect(result.stdoutOmittedBytes).toBeGreaterThan(0);
      // The producer was never blocked: it ran to completion past the cap.
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Environment exfiltration (regression — the fence once passed host env
  // through unfiltered, so ~/.aws was denied on disk while
  // AWS_SECRET_ACCESS_KEY was readable from os.environ)
  // -------------------------------------------------------------------------

  describe('environment exfiltration', () => {
    const CANARY_VALUE = 'bst-1071-env-canary-must-not-cross';
    const CANARY_KEYS = [
      'ANTHROPIC_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'NPM_TOKEN',
      'OPENAI_API_KEY',
    ] as const;

    it('lets NO host environment value cross the fence beyond the declared allow-list', async () => {
      const saved = new Map<string, string | undefined>();
      for (const key of CANARY_KEYS) {
        saved.set(key, process.env[key]);
        process.env[key] = `${CANARY_VALUE}-${key}`;
      }
      const dumpPath = join(scratchDir, 'fence-env.json');
      rmSync(dumpPath, { force: true });

      try {
        const result = await run(
          [
            'import json, os',
            `json.dump(dict(os.environ), open(${JSON.stringify(dumpPath)}, "w"))`,
            'print("DUMPED", len(os.environ))',
          ].join('\n')
        );
        expect(result.exitCode).toBe(0);
        expect(existsSync(dumpPath)).toBe(true);

        const fenceEnv = JSON.parse(readFileSync(dumpPath, 'utf8')) as Record<string, string>;

        // 1. No secret-shaped NAME survives.
        for (const key of CANARY_KEYS) {
          expect(Object.keys(fenceEnv)).not.toContain(key);
        }
        // 2. No canary VALUE survives under ANY name — a rename would not help.
        expect(Object.values(fenceEnv).join('\0')).not.toContain(CANARY_VALUE);
        // 3. The structural claim, which is what actually makes this a
        //    regression guard rather than a list of names to keep extending:
        //    the only host variables that reach the sandbox with their host
        //    value intact are the ones we deliberately inherit (plus the
        //    shell/OS bookkeeping the far side re-adds itself).
        const survivingHostKeys = Object.entries(fenceEnv)
          .filter(([key, value]) => process.env[key] === value)
          .map(([key]) => key)
          .filter(
            (key) => !(INHERITED_ENV_VARS.includes(key) || OS_READDED_ENV_KEYS.includes(key))
          );
        expect(survivingHostKeys).toEqual([]);
        // 4. Non-vacuity: the allow-list really did pass something through, so
        //    an empty environment cannot make points 1-3 pass by default.
        expect(Object.keys(fenceEnv)).toContain('PATH');
        expect(Object.keys(fenceEnv)).toContain('HOME');
      } finally {
        for (const [key, value] of saved) {
          if (value === undefined) {
            Reflect.deleteProperty(process.env, key);
          } else {
            process.env[key] = value;
          }
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Teardown and cancellation (regression — a detached grandchild could
  // outlive execute() and still be running when the NEXT run installed a
  // different allowedDomains, inheriting run B's egress)
  // -------------------------------------------------------------------------

  describe('teardown and cancellation', () => {
    /**
     * A descendant that detaches its stdio and ticks a counter file.
     *
     * The counter is what makes the survival check both non-vacuous and
     * timing-independent: a tick that already landed proves the descendant
     * really ran, and a counter that does not advance over a window many times
     * longer than the tick interval proves it is gone. Nothing here asserts
     * that the kill happened within a particular number of milliseconds.
     */
    const TICK_INTERVAL_S = 0.05;
    const heartbeatDescendant = (counterPath: string): string =>
      [
        'import os, time',
        'for i in range(2000):',
        // Written to a temp name then renamed, so a reader on the host can
        // never catch a half-written counter and mistake it for a stall.
        `    tmp = ${JSON.stringify(`${counterPath}.tmp`)}`,
        '    f = open(tmp, "w")',
        '    f.write(str(i))',
        '    f.close()',
        `    os.replace(tmp, ${JSON.stringify(counterPath)})`,
        `    time.sleep(${TICK_INTERVAL_S})`,
      ].join('\n');

    const readCounter = (counterPath: string): number | undefined => {
      if (!existsSync(counterPath)) {
        return;
      }
      const raw = readFileSync(counterPath, 'utf8').trim();
      return raw === '' ? undefined : Number(raw);
    };

    /** Long enough to cover many ticks; deliberately not a tight bound. */
    const OBSERVATION_MS = 3000;

    /**
     * Python that blocks until `path` appears, or a generous deadline passes.
     *
     * Used instead of a fixed sleep before the parent returns. The survival
     * checks below are only meaningful once the descendant has demonstrably
     * run, and interpreter startup inside a Seatbelt/bubblewrap profile on a
     * loaded runner has no upper bound — a fixed window that occasionally
     * expires first would turn these RED claiming a teardown regression that
     * did not happen. Waiting for the event keeps the non-vacuity check and
     * removes the clock from the assertion.
     */
    const waitForFile = (path: string): string[] => [
      '__deadline = time.time() + 20',
      `while not os.path.exists(${JSON.stringify(path)}) and time.time() < __deadline:`,
      '    time.sleep(0.02)',
    ];

    it('leaves no ticking descendant alive when execute() settles normally', async () => {
      const counter = join(scratchDir, 'normal-heartbeat.txt');
      rmSync(counter, { force: true });

      const result = await run(
        [
          'import os, subprocess, sys, time',
          'devnull = os.open(os.devnull, os.O_RDWR)',
          `subprocess.Popen([sys.executable, "-c", ${JSON.stringify(heartbeatDescendant(counter))}], stdin=devnull, stdout=devnull, stderr=devnull)`,
          // Wait for the descendant's FIRST tick, not a fixed duration.
          ...waitForFile(counter),
          'print("PARENT-DONE")',
        ].join('\n')
      );

      expect(result.stdout).toContain('PARENT-DONE');
      expect(result.timedOut).toBe(false);

      const atSettle = readCounter(counter);
      // Non-vacuity: the descendant really was running with detached stdio.
      // Without this the "did not advance" check below would pass for a
      // descendant that never started.
      expect(atSettle).toBeTypeOf('number');

      await new Promise((resolve) => setTimeout(resolve, OBSERVATION_MS));
      expect(readCounter(counter)).toBe(atSettle);
    }, 30_000);

    it('leaves no ticking descendant alive when the run is ABORTED', async () => {
      const counter = join(scratchDir, 'abort-heartbeat.txt');
      rmSync(counter, { force: true });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 1500);

      let caught: unknown;
      try {
        await run(
          [
            'import os, subprocess, sys, time',
            'devnull = os.open(os.devnull, os.O_RDWR)',
            'print("BEFORE-ABORT", flush=True)',
            `subprocess.Popen([sys.executable, "-c", ${JSON.stringify(heartbeatDescendant(counter))}], stdin=devnull, stdout=devnull, stderr=devnull)`,
            'time.sleep(120)',
          ].join('\n'),
          {},
          60_000,
          controller.signal
        );
      } catch (error) {
        caught = error;
      }

      expect(isExecAbortedError(caught)).toBe(true);
      if (!isExecAbortedError(caught)) {
        throw new Error('unreachable');
      }
      expect(caught.processStarted).toBe(true);
      expect(caught.partialStdout).toContain('BEFORE-ABORT');

      const atSettle = readCounter(counter);
      expect(atSettle).toBeTypeOf('number');
      await new Promise((resolve) => setTimeout(resolve, OBSERVATION_MS));
      expect(readCounter(counter)).toBe(atSettle);
    }, 40_000);

    it('throws ExecAbortedError with processStarted:false when aborted while QUEUED, and never runs the code', async () => {
      // The other half of cancellation: Stop pressed behind another execution
      // must not wait for it, and must not run the queued code afterwards.
      const marker = join(scratchDir, 'queued-run-marker.txt');
      rmSync(marker, { force: true });

      const controller = new AbortController();
      const occupying = run('import time; time.sleep(4); print("OCCUPYING-DONE")', {}, 40_000);
      // Let the occupying run take the module-global queue slot.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const queued = run(
        `open(${JSON.stringify(marker)}, "w").write("the queued run executed")`,
        {},
        40_000,
        controller.signal
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      controller.abort();

      let caught: unknown;
      try {
        await queued;
      } catch (error) {
        caught = error;
      }
      const occupyingResult = await occupying;

      expect(isExecAbortedError(caught)).toBe(true);
      if (!isExecAbortedError(caught)) {
        throw new Error('unreachable');
      }
      // Nothing spawned, so there are no partial side effects to reason about.
      expect(caught.processStarted).toBe(false);
      expect(existsSync(marker)).toBe(false);
      // Non-vacuity: the queue really was occupied, so the abort landed in the
      // QUEUED position rather than before any run existed.
      expect(occupyingResult.stdout).toContain('OCCUPYING-DONE');
    }, 60_000);

    it.skipIf(networkSkipReason !== undefined)(
      "does not let a leftover descendant of run A inherit run B's egress",
      async () => {
        // The P1 this suite exists to keep closed. Run A has NO network. It
        // leaves a detached descendant that waits, then tries to reach a host
        // run B allow-lists. If the descendant outlived run A's settle, it
        // would be alive under run B's proxy configuration — run A's code
        // exfiltrating through run B's permission.
        const started = join(scratchDir, 'leftover-started.txt');
        const egress = join(scratchDir, 'leftover-egress.txt');
        rmSync(started, { force: true });
        rmSync(egress, { force: true });

        const leftover = [
          'import time, urllib.request',
          `open(${JSON.stringify(started)}, "w").write("leftover is running")`,
          'time.sleep(2)',
          'try:',
          `    r = urllib.request.urlopen(${JSON.stringify(PROBE_URL)}, timeout=15)`,
          `    open(${JSON.stringify(egress)}, "w").write("REACHED %d" % r.status)`,
          'except Exception as e:',
          `    open(${JSON.stringify(egress)}, "w").write("BLOCKED %s" % type(e).__name__)`,
        ].join('\n');

        const runA = await run(
          [
            'import os, subprocess, sys, time',
            'devnull = os.open(os.devnull, os.O_RDWR)',
            `subprocess.Popen([sys.executable, "-c", ${JSON.stringify(leftover)}], stdin=devnull, stdout=devnull, stderr=devnull)`,
            // Same reason as above, and it matters more here: this is the P1
            // regression guard, so a startup spike must not fail it for the
            // wrong reason.
            ...waitForFile(started),
            'print("RUN-A-DONE")',
          ].join('\n')
        );
        expect(runA.stdout).toContain('RUN-A-DONE');
        // Non-vacuity: the descendant genuinely existed and ran code.
        expect(existsSync(started)).toBe(true);
        // It was killed before it could even reach its own egress attempt.
        expect(existsSync(egress)).toBe(false);

        // Run B installs a PERMISSIVE allow-list covering exactly the host the
        // leftover wanted, and proves that egress is live right now.
        const runB = await run(
          [
            'import urllib.request',
            `r = urllib.request.urlopen(${JSON.stringify(PROBE_URL)}, timeout=20)`,
            'print("RUN-B-STATUS", r.status)',
          ].join('\n'),
          { allowedDomains: [PROBE_HOST] }
        );
        expect(runB.stdout).toContain('RUN-B-STATUS 200');

        // Past the leftover's own 2s wake-up, with run B's allow-list live.
        await new Promise((resolve) => setTimeout(resolve, OBSERVATION_MS));
        expect(existsSync(egress)).toBe(false);
      },
      60_000
    );
  });
});

// ---------------------------------------------------------------------------
// Regression guard — deliberately OUTSIDE the host gate
// ---------------------------------------------------------------------------

/**
 * Not inside `describe.skipIf(hostSkipReason)` above, and that placement is the
 * whole point: this assertion is about the installed dependency graph, not
 * about the host's sandboxing ability. Gated, an srt bump would stay green on
 * every machine without bwrap/ripgrep/python — silently voiding the promise in
 * docs/agents/code-execution.md that a bump turns this suite red. Ungated, the
 * pin is checked wherever the integration lane runs at all.
 */
describe('fence escape resistance — srt version pin', () => {
  it(`is proven only against @anthropic-ai/sandbox-runtime ${PINNED_SRT_VERSION}`, () => {
    expect(installedSrtVersion()).toBe(PINNED_SRT_VERSION);
    // If this fails, srt moved. Do NOT just update the constant: the fence's
    // guarantees are srt's guarantees, and this suite is the evidence for
    // them. Re-run it in full on macOS AND Linux, re-check the README's
    // non-guarantee list against the new srt README, and only then re-pin.
  });
});
