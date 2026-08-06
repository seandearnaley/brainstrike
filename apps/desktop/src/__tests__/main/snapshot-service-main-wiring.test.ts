import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Wiring contract for the W7 shadow-git SnapshotService (BST-1164 T1),
 * mirroring `command-session-main-wiring.test.ts`'s source-pin style. This
 * test exists because of the GitInventoryService incident class: a
 * module-scope construction/start once turned a service into a silent
 * every-boot no-op (pre-ready `utilityProcess` spawns reject, cached as a
 * false empty snapshot) — wiring mistakes in main.ts are invisible to unit
 * suites that mock main.ts away.
 */
describe('snapshot service lifecycle wiring', () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../main.ts'), 'utf8');

  it('constructs the ONE SnapshotService inside app.whenReady with the pinned runner and base dir', () => {
    expect(source).toContain("snapshotsBaseDir = path.join(app.getPath('userData'), 'snapshots')");
    expect(source).toMatch(
      /const constructedSnapshotService = createSnapshotService\(\{\s*runner: execFileSnapshotGitRunner,\s*snapshotsBaseDir,\s*\}\);/
    );
    expect(source).toContain('snapshotService = constructedSnapshotService;');
    // Inside whenReady, never at module scope (the incident class): the
    // construction call site must appear AFTER the whenReady entry.
    const whenReadyIndex = source.indexOf('app.whenReady().then');
    const constructionIndex = source.indexOf('createSnapshotService({');
    expect(whenReadyIndex).toBeGreaterThan(-1);
    expect(constructionIndex).toBeGreaterThan(whenReadyIndex);
    // Exactly one construction site — a second instance would fork the
    // per-root mutexes the service exists to serialize.
    expect(source.indexOf('createSnapshotService({', constructionIndex + 1)).toBe(-1);
  });

  it('threads the service and repository factory into the changes IPC handlers lazily', () => {
    expect(source).toMatch(
      /createChangesIpcHandlers\(\{[\s\S]*?createSnapshotRepository,[\s\S]*?resolveSnapshotService: \(\) => snapshotService,[\s\S]*?\}\)/
    );
  });

  it('threads the snapshot deps into the assistant server (run-persistence seam)', () => {
    expect(source).toMatch(
      /startAssistantServer\(undefined, \{[\s\S]*?snapshots: \{\s*createRepository: createSnapshotRepository,\s*service: constructedSnapshotService,\s*\},[\s\S]*?\}\)/
    );
  });

  it('runs the T4 startup GC after the orphan sweep, inside the same fire-and-forget block, with per-item failure logging', () => {
    // GC runs AFTER sweepOrphans (vanished-root repos must already be gone)
    // and inside the same non-blocking block.
    const sweepIndex = source.indexOf('constructedSnapshotService.sweepOrphans');
    const gcIndex = source.indexOf('runSnapshotStartupGc({');
    expect(sweepIndex).toBeGreaterThan(-1);
    expect(gcIndex).toBeGreaterThan(sweepIndex);
    // The GC consumes the ONE service + the repository factory over the same
    // database handle, and the full roots rows (id + path).
    expect(source).toMatch(
      /runSnapshotStartupGc\(\{\s*db: gcDatabase,\s*liveRoots: rootRows\.rows\.map\(\(row\) => \(\{ path: row\.path, rootId: row\.id \}\)\),\s*snapshotRepository: createSnapshotRepository\(gcDatabase\),\s*snapshotService: constructedSnapshotService,\s*\}\)/
    );
    expect(source).toContain('SELECT id, path FROM roots');
    // Failures are logged VISIBLY, one line per item, plus the summary line.
    expect(source).toContain("logger.error('Workspace snapshot GC item failed', { failure })");
    expect(source).toContain("logger.info('Workspace snapshot startup GC completed'");
  });

  it('threads the snapshot service into the assistant-checkpoint IPC handlers lazily (T4 undo engine)', () => {
    expect(source).toMatch(
      /registerAssistantCheckpointIpcHandlers\(\{\s*resolveSnapshotService: \(\) => snapshotService,\s*\}\)/
    );
  });

  it('runs the startup orphan sweep without blocking startup, with visible logging both ways', () => {
    expect(source).toMatch(
      /constructedSnapshotService\.sweepOrphans\(\s*snapshotsBaseDir,\s*rootRows\.rows\.map\(\(row\) => row\.id\)\s*\)/
    );
    expect(source).toContain("logger.info('Workspace snapshot orphan sweep completed'");
    expect(source).toContain("logger.error('Workspace snapshot orphan sweep failed'");
    // Fire-and-forget: the sweep is a `void (async () => {` block, not an
    // awaited step of the boot sequence.
    const sweepIndex = source.indexOf('constructedSnapshotService.sweepOrphans');
    const fireAndForgetIndex = source.lastIndexOf('void (async () => {', sweepIndex);
    expect(fireAndForgetIndex).toBeGreaterThan(-1);
    expect(source.slice(fireAndForgetIndex, sweepIndex)).not.toContain(
      'await startAssistantServer'
    );
  });
});
