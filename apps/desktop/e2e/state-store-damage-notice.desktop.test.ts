/**
 * Desktop E2E (BST-1880): a damaged state DB opens read-only, and the app says
 * so with the store's own finding. "Check again" re-reads the running host;
 * "Restart agent host and check" relaunches the host, so its store opens and
 * checks itself again. Neither changes the damaged file. BST-2144: the writes
 * the app attempts meanwhile are typed read-only refusals, never errors.
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from './fixtures/electron-fixture';
import { readHostProcess, readHostRoot, waitForAppHost } from './utils/agent-host-log';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { seedHostThreads } from './utils/seed-threads';

/**
 * What the app logged as an error about writing to the read-only store: Main's
 * structured stdout records, and the renderer console relayed on stderr. The
 * fixture buffers output chunk by chunk, so records are re-joined and split
 * where each one starts rather than parsed line by line.
 */
function readOnlyWriteErrors(output: { stderr: string[]; stdout: string[] }): string[] {
  const main = output.stdout
    .join('')
    .split(/(?=\{"level":)/u)
    .filter(
      (record) =>
        /^\{"level":(?:5\d|6\d)\b/u.test(record) &&
        (record.includes('"msg":"Workspace root database convergence failed"') ||
          /readonly database|is read-only/u.test(record))
    );
  const rendererText = output.stderr.join('');
  const renderer = rendererText.includes('Failed to initialize provider model defaults')
    ? ['Failed to initialize provider model defaults']
    : [];
  return [...main, ...renderer];
}

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
    await waitForAppHost(page);
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

    const { getBufferedElectronOutput } = await loadElectronHelpers();
    const output = await getBufferedElectronOutput((await electron.ensureContext()).app);
    expect(output.stdout.join('')).toContain('"msg":');
    expect(readOnlyWriteErrors(output)).toEqual([]);

    await electron.dispose();
    expect(statSync(file).ino).toBe(inode);
    expect(readFileSync(file)[cell.offset]).toBe(cell.value);
  });
});
