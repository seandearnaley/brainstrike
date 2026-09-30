import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export function validateAppImageHeader(header) {
  if (
    header.length < 64 ||
    header.readUInt32BE(0) !== 0x7f_45_4c_46 ||
    header[4] !== 2 ||
    header[5] !== 1 ||
    header[8] !== 0x41 ||
    header[9] !== 0x49 ||
    header[10] !== 2 ||
    header.readUInt16LE(18) !== 62
  ) {
    throw new Error('Expected a Linux x64 ELF type-2 AppImage, not an unpacked executable.');
  }
}

export async function inspectArtifact(filename) {
  const resolved = await realpath(filename);
  const info = await stat(resolved);
  if (!info.isFile() || (info.mode & 0o111) === 0) {
    throw new Error('AppImage input must be an executable regular file.');
  }
  const file = await open(resolved, 'r');
  try {
    const header = Buffer.alloc(64);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    validateAppImageHeader(header.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(resolved)) {
    hash.update(chunk);
  }
  return { bytes: info.size, path: resolved, sha256: hash.digest('hex') };
}

export function inspectDesktopEntry(source) {
  const sections = source.split(/^\[/mu);
  const section = sections.find((value) => value.startsWith('Desktop Entry]'));
  if (!section) {
    throw new Error('AppImage is missing its Desktop Entry section.');
  }
  const fields = new Map(
    section
      .split('\n')
      .slice(1)
      .filter((line) => !line.startsWith('#'))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1).trim()];
      })
  );
  const entry = Object.fromEntries(
    ['Name', 'Exec', 'Icon', 'X-AppImage-Version'].map((key) => [key, fields.get(key)])
  );
  if (Object.values(entry).some((value) => !value)) {
    throw new Error(
      'AppImage desktop metadata must include Name, Exec, Icon and X-AppImage-Version.'
    );
  }
  return {
    disablesSandbox: /--(?:no-sandbox|disable-setuid-sandbox|disable-namespace-sandbox)\b/u.test(
      entry.Exec
    ),
    exec: entry.Exec,
    icon: entry.Icon,
    name: entry.Name,
    version: entry['X-AppImage-Version'],
  };
}

export async function inspectAppImageMetadata({ artifact, directory, env, signal }) {
  // Extract only metadata, never execute AppRun. Mounted lifecycle mode still
  // launches the original image normally; metadata extraction is not fallback.
  for (const pattern of ['AppRun', '*.desktop']) {
    await execute(artifact, ['--appimage-extract', pattern], {
      cwd: directory,
      env,
      killSignal: 'SIGKILL',
      maxBuffer: 1_000_000,
      signal,
      timeout: 30_000,
    }).catch(() => {
      throw new Error('AppImage metadata extraction failed; no app launch was attempted.');
    });
  }
  const extracted = path.join(directory, 'squashfs-root');
  const entries = (await readdir(extracted)).filter((name) => name.endsWith('.desktop'));
  if (entries.length !== 1) {
    throw new Error('Expected exactly one top-level AppImage desktop entry.');
  }
  const appRun = await readFile(path.join(extracted, 'AppRun'));
  const desktop = inspectDesktopEntry(await readFile(path.join(extracted, entries[0]), 'utf8'));
  return {
    appRunMentionsSandboxBypass: appRun.includes('--no-sandbox'),
    appRunSha256: createHash('sha256').update(appRun).digest('hex'),
    desktop,
  };
}

export async function requireUserNamespaces({ env, signal }) {
  // The pinned builder's AppRun silently adds --no-sandbox on a failed probe.
  // Refuse BEFORE running it. Do not alter AppArmor, sysctls, or chrome-sandbox.
  await execute('unshare', ['-Ur', 'true'], { env, signal, timeout: 5000 }).catch(() => {
    throw new Error(
      'Unprivileged user namespaces are unavailable; AppRun may disable the sandbox. No app launch was attempted.'
    );
  });
}
