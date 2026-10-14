import { randomUUID } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from './fixtures/electron-fixture';
import { readHostRoot, withAppHost } from './utils/agent-host-log';
import { seedHostThreads } from './utils/seed-threads';

/** Read intact table pages without trusting the deliberately damaged secondary index. */
function retainedRows(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      events: db.prepare('SELECT * FROM run_events NOT INDEXED ORDER BY id').all(),
      presets: db.prepare('SELECT * FROM view_filter_presets ORDER BY id').all(),
    };
  } finally {
    db.close();
  }
}

/** Same physical unique-index cell corruption as StateStore's i3-corruption proof. */
function corruptRunIndex(file: string): { offset: number; value: number } {
  const db = new DatabaseSync(file, { readOnly: true });
  let offset: number;
  try {
    const pageSize = Number(db.prepare('PRAGMA page_size').get()?.['page_size']);
    const leaf = Number(
      db
        .prepare(
          "SELECT pageno FROM dbstat WHERE name='sqlite_autoindex_run_events_1' AND pagetype='leaf' ORDER BY pageno"
        )
        .get()?.['pageno']
    );
    expect(Number.isInteger(pageSize) && pageSize > 0).toBe(true);
    expect(Number.isInteger(leaf) && leaf > 0).toBe(true);
    offset = leaf * pageSize - 3;
  } finally {
    db.close();
  }
  const bytes = readFileSync(file);
  const previous = bytes[offset];
  if (previous === undefined) {
    throw new Error('Native index cell lies outside the disposable database');
  }
  const value = previous ^ 1;
  bytes[offset] = value;
  writeFileSync(file, bytes);
  return { offset, value };
}

function integrity(file: string): { quick: readonly unknown[]; full: readonly unknown[] } {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      full: db.prepare('PRAGMA integrity_check').all(),
      quick: db.prepare('PRAGMA quick_check').all(),
    };
  } finally {
    db.close();
  }
}

test.describe('Database integrity containment (desktop) @desktop-db-storage', () => {
  test('shows native index damage read-only without replacing precious data', async ({
    electron,
    window: page,
  }) => {
    const userData = await page.evaluate(() => globalThis.window.electronAPI!.getUserDataPath());
    const preset = await page.evaluate(async () => {
      const capability = window.viewFilterPresets;
      if (!capability) {
        throw new Error('Native preset capability is unavailable');
      }
      const result = await capability.request({
        input: { excludes: [], includes: [], name: 'Precious integrity probe' },
        operation: 'create',
      });
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.value.presets[0];
    });
    expect(preset?.id).toBeTruthy();
    const [threadId] = await seedHostThreads(userData, [
      { folder: null, title: 'Preserved damaged conversation' },
    ]);
    if (!threadId) {
      throw new Error('Host did not commit the fixture conversation');
    }
    const file = join(await readHostRoot(userData), 'state.db');
    await electron.closeForStateSeeding();
    const before = retainedRows(file);
    expect(before.events.length).toBeGreaterThan(0);
    expect(before.presets.some((row) => row['id'] === preset?.id)).toBe(true);
    const inode = statSync(file).ino;
    const cell = corruptRunIndex(file);
    const damaged = integrity(file);
    expect(damaged.quick).toEqual([{ quick_check: 'ok' }]);
    expect(damaged.full).not.toEqual([{ integrity_check: 'ok' }]);
    expect(retainedRows(file)).toEqual(before);
    await test.info().attach('native-corruption-receipt', {
      body: JSON.stringify({ cell, damaged, inode, threadId }),
      contentType: 'application/json',
    });

    const reopened = await electron.ensureWindow({ preserveState: true });
    const showThreads = reopened.getByTestId('show-threads-panel');
    if (await showThreads.isVisible()) {
      await showThreads.click();
    }
    await reopened.getByTestId('threads-tab-trigger').click();
    await expect(
      reopened
        .getByTestId('thread-read-failure')
        .and(reopened.getByRole('button', { name: new RegExp(threadId) }))
    ).toBeVisible();
    const catalog = await withAppHost(userData, (host) => host.request('thread/list', {}));
    expect(catalog.threads.find((thread) => thread.threadId === threadId)?.damage).toBeTruthy();
    await expect(
      withAppHost(userData, (host) =>
        host.request('thread/update', {
          commandId: randomUUID(),
          threadId,
          title: 'A damaged database must refuse this write',
        })
      )
    ).rejects.toThrow();
    await electron.dispose();

    expect(statSync(file).ino).toBe(inode);
    expect(readFileSync(file)[cell.offset]).toBe(cell.value);
    expect(retainedRows(file)).toEqual(before);
    expect(integrity(file)).toEqual(damaged);
  });
});
