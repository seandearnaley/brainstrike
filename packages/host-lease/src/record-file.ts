import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeHostRecord, HOST_RECORD_FILE, type HostRecord, tokensEqual } from './record.js';
import { windowsPrivateAcl } from './windows-acl.js';

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
export async function secureDirectory(root: string): Promise<void> {
  await mkdir(root, { mode: 0o700, recursive: true });
  if (process.platform === 'win32') {
    await windowsPrivateAcl(root, 'directory', 'set');
    return;
  }
  const info = await stat(root);
  if (info.uid !== process.getuid?.()) {
    throw new Error(`Host directory belongs to another user: ${root}`);
  }
  await chmod(root, 0o700);
}
async function syncDirectory(root: string): Promise<void> {
  // Windows cannot open directories through Node's fs API; the private record
  // is non-authoritative discovery metadata, and its file itself is flushed.
  if (process.platform === 'win32') {
    return;
  }
  const directory = await open(root, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function readHostRecord(root: string): Promise<HostRecord | null> {
  const path = join(root, HOST_RECORD_FILE);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 8192) {
      throw new TypeError('host.json must be a bounded regular file');
    }
    if (process.platform === 'win32') {
      await windowsPrivateAcl(path, 'file', 'verify');
    }
    if (process.platform !== 'win32' && (info.mode & 0o777) !== 0o600) {
      throw new Error('host.json must have mode 0600');
    }
    return decodeHostRecord(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
}
export async function publishHostRecord(root: string, record: HostRecord): Promise<void> {
  const path = join(root, HOST_RECORD_FILE);
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      if (process.platform === 'win32') {
        await windowsPrivateAcl(temporary, 'file', 'set');
      }
      await file.writeFile(`${JSON.stringify(decodeHostRecord(record))}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    await syncDirectory(root);
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function removeOwnHostRecord(root: string, record: HostRecord): Promise<void> {
  const current = await readHostRecord(root);
  if (!(current && tokensEqual(current.token, record.token))) {
    return;
  }
  await rm(join(root, HOST_RECORD_FILE));
  await syncDirectory(root);
}
