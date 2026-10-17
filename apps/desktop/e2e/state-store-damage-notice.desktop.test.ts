/**
 * Desktop E2E (BST-1880): a damaged state DB opens read-only, and the app says
 * so with the store's own finding. "Check again" re-reads the running host;
 * "Restart agent host and check" relaunches the host, so its store opens and
 * checks itself again. Neither changes the damaged file.
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from './fixtures/electron-fixture';
import { readHostProcess, readHostRoot } from './utils/agent-host-log';
import { seedHostThreads } from './utils/seed-threads';

/** The containment proof's damage: one unique-index cell, so the table pages still read. */
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
    offset = leaf * pageSize - 3;
  } finally {
    db.close();
  }
  const bytes = readFileSync(file);
  const value = (bytes[offset] ?? 0) ^ 1;
  bytes[offset] = value;
  writeFileSync(file, bytes);
  return { offset, value };
}

test.describe('Damaged state store notice (desktop) @desktop-db-storage', () => {
  test('a damaged state DB is shown read-only, re-checked, and re-checked after a host restart', async ({
    electron,
    window: page,
  }) => {
    test.setTimeout(240_000);
    const userData = await page.evaluate(() => globalThis.window.electronAPI!.getUserDataPath());
    // The shell starts the agent host; its record appears once it is serving.
    await expect
      .poll(
        () =>
          readHostProcess(userData).then(
            () => true,
            () => false
          ),
        { timeout: 60_000 }
      )
      .toBe(true);
    await seedHostThreads(userData, [{ folder: null, title: 'Kept through the damage' }]);
    const file = join(await readHostRoot(userData), 'state.db');
    await electron.closeForStateSeeding();
    const inode = statSync(file).ino;
    const cell = corruptRunIndex(file);

    const reopened = await electron.ensureWindow({ preserveState: true });
    const notice = reopened.getByTestId('state-store-damage-notice');
    await expect(notice).toContainText(
      'BrainStrike’s conversation store is damaged, so it opened read-only.',
      { timeout: 60_000 }
    );
    await expect(notice).toContainText('Nothing was deleted or replaced.');
    await notice.getByText('Details').click();
    await expect(notice).toContainText('missing from index');

    await notice.getByRole('button', { name: 'Check again' }).click();
    await expect(notice.getByRole('status')).toContainText('still damaged.', { timeout: 30_000 });

    const before = await readHostProcess(userData);
    await notice.getByRole('button', { name: 'Restart agent host and check' }).click();
    await expect(notice.getByRole('button', { name: 'Restart agent host and check' })).toBeEnabled({
      timeout: 90_000,
    });
    expect(await notice.textContent()).not.toContain('Couldn’t');
    const after = await readHostProcess(userData);
    expect(after.pid).not.toBe(before.pid);
    await expect(notice).toContainText('missing from index');
    await expect(notice.getByRole('status')).toContainText('still damaged.');

    await electron.dispose();
    expect(statSync(file).ino).toBe(inode);
    expect(readFileSync(file)[cell.offset]).toBe(cell.value);
  });
});
