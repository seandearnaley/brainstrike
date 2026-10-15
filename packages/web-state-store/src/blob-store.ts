/**
 * The browser writer's content-addressed blobs: the desktop writer's blob
 * directory (`writer-worker.mjs` putBlob/unlinkBlobs), as OPFS files in the
 * store's pool directory, which Factory Reset removes whole. A blob is
 * written to a temporary name, flushed, then moved to its hash, so a name
 * only ever holds complete bytes; reads verify the bytes against the name.
 */

const HASH = /^[a-f0-9]{64}$/;
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder('utf-8', { fatal: true });

/** OPFS's move, which lib.dom does not declare yet. */
interface MovableFileHandle extends FileSystemFileHandle {
  move(newName: string): Promise<void>;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isMissing(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

export class OpfsBlobStore {
  private constructor(private readonly directory: FileSystemDirectoryHandle) {}

  /** The `blobs` directory inside `poolDirectory`, created if absent. */
  static async open(poolDirectory: string): Promise<OpfsBlobStore> {
    const root = await navigator.storage.getDirectory();
    const pool = await root.getDirectoryHandle(poolDirectory, { create: true });
    return new OpfsBlobStore(await pool.getDirectoryHandle('blobs', { create: true }));
  }

  /** Stores `content` under `hash`; an existing blob is kept after its bytes are verified. */
  async put(hash: string, content: string): Promise<void> {
    const bytes = utf8.encode(content);
    if (!HASH.test(hash) || (await sha256(bytes)) !== hash) {
      throw new Error('blob hash does not match its content');
    }
    if (await this.bytes(hash)) {
      await this.verify(hash);
      return;
    }
    const temporary = await this.directory.getFileHandle(`${hash}.tmp`, { create: true });
    const access = await temporary.createSyncAccessHandle();
    try {
      access.truncate(0);
      let offset = 0;
      while (offset < bytes.length) {
        offset += access.write(bytes.subarray(offset), { at: offset });
      }
      access.flush();
    } finally {
      access.close();
    }
    await (temporary as MovableFileHandle).move(hash);
  }

  /** Throws unless `hash` names a stored blob whose bytes still hash to it. */
  async verify(hash: string): Promise<void> {
    const bytes = await this.bytes(hash);
    if (!bytes) {
      throw new Error(`event references missing blob ${hash}`);
    }
    if ((await sha256(bytes)) !== hash) {
      throw new Error(`blob ${hash} checksum mismatch`);
    }
  }

  /** The blob's text, verified; null when it is larger than `maxBytes`. */
  async read(hash: string, maxBytes: number): Promise<string | null> {
    const file = await this.file(hash);
    if (!file) {
      throw new Error(`blob ${hash} is missing`);
    }
    if (file.size > maxBytes) {
      return null;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if ((await sha256(bytes)) !== hash) {
      throw new Error(`blob ${hash} checksum mismatch`);
    }
    return fromUtf8.decode(bytes);
  }

  /** Removes the named blobs that exist; returns the hashes actually removed. */
  async unlink(hashes: readonly string[]): Promise<string[]> {
    const deleted: string[] = [];
    for (const hash of hashes) {
      if (!HASH.test(hash)) {
        throw new Error(`invalid blob hash ${hash}`);
      }
      try {
        await this.directory.removeEntry(hash);
        deleted.push(hash);
      } catch (error) {
        if (!isMissing(error)) {
          throw error;
        }
      }
    }
    return deleted;
  }

  private async bytes(hash: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
    const file = await this.file(hash);
    return file ? new Uint8Array(await file.arrayBuffer()) : undefined;
  }

  private async file(hash: string): Promise<File | undefined> {
    if (!HASH.test(hash)) {
      throw new Error(`invalid blob hash ${hash}`);
    }
    try {
      return await (await this.directory.getFileHandle(hash)).getFile();
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      throw error;
    }
  }
}
