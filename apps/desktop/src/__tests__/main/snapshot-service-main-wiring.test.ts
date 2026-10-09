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

  it('publishes the service before launching startup maintenance on that same instance', () => {
    const assignmentIndex = source.indexOf('snapshotService = constructedSnapshotService;');
    const maintenanceIndex = source.indexOf('startSnapshotStartupMaintenance({');
    expect(assignmentIndex).toBeGreaterThan(source.indexOf('createSnapshotService({'));
    expect(maintenanceIndex).toBeGreaterThan(assignmentIndex);
    expect(source).toMatch(
      /startSnapshotStartupMaintenance\(\{\s*getDatabase,\s*logger,\s*mainProcessStartedAt,\s*readHostThreadIds,\s*snapshotService: constructedSnapshotService,\s*snapshotsBaseDir,\s*\}\)/
    );
    expect(source.indexOf('startSnapshotStartupMaintenance({', maintenanceIndex + 1)).toBe(-1);
  });

  it('threads the snapshot service into the assistant-checkpoint IPC handlers lazily (T4 undo engine)', () => {
    expect(source).toMatch(
      /registerAssistantCheckpointIpcHandlers\(\{\s*resolveSnapshotService: \(\) => snapshotService,\s*\}\)/
    );
  });
});
