import { basename, dirname, isAbsolute } from 'node:path';
import { SecureRoot } from '@brainstrike/secure-fs-native';

function openParent(path: string): SecureRoot {
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new TypeError('The credential file requires an explicit absolute path.');
  }
  return new SecureRoot(dirname(path));
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** The credential facade owns serialization and joins these actual operations. */
export async function readPrivateCredentialFile(path: string): Promise<string | undefined> {
  let root: SecureRoot;
  try {
    root = openParent(path);
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
  try {
    const result = await root.readPrivateFileAsync(basename(path));
    if (result.status === 'not-found') {
      return undefined;
    }
    if (result.status !== 'ok') {
      throw new Error('The configured credential file requires a private regular file.');
    }
    return result.content.toString('utf8');
  } finally {
    root.close();
  }
}

export async function writePrivateCredentialFile(path: string, content: string): Promise<void> {
  const root = openParent(path);
  try {
    await root.writePrivateFileAsync(basename(path), Buffer.from(content, 'utf8'));
  } finally {
    root.close();
  }
}
