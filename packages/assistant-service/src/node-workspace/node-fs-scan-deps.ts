/**
 * Real-disk fs scan deps for user slash-command / persona discovery (moved
 * verbatim from ipc-user-commands-handlers.ts, BST-972 A2 — the assistant
 * stream path consumed it there, which was the assistant server's widest
 * cross-module reach; the IPC handlers now import from here instead).
 */
import path from 'node:path';
import { createLogger } from '@brainstrike/logging';
import { SecureRoot } from '@brainstrike/secure-fs-native';
import {
  MAX_USER_COMMAND_FILE_BYTES,
  type UserSlashCommandScanDeps,
} from './user-slash-commands-loader.js';

// Same scope string the function logged under at its previous home, so the
// warn below stays byte-identical in log output.
const logger = createLogger('UserSlashCommands');

/** Real-disk fs deps: a directory read yields entries; a missing path yields null. */
export function createNodeFsScanDeps(): UserSlashCommandScanDeps & { dispose: () => void } {
  const roots = new Map<string, SecureRoot>();
  const directories = new Map<string, { relativePath: string; root: SecureRoot }>();
  return {
    dispose: () => {
      for (const root of roots.values()) {
        root.close();
      }
      roots.clear();
      directories.clear();
    },
    listDir: (absDir, containmentRoot, maxEntries) => {
      try {
        const relative = path.relative(containmentRoot, absDir);
        if (
          relative === '..' ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        ) {
          logger.warn('Skipping symlinked slash command directory');
          return null;
        }
        const root = roots.get(containmentRoot) ?? new SecureRoot(containmentRoot);
        roots.set(containmentRoot, root);
        const listing = root.listDir(relative || '.', maxEntries);
        if (!listing) {
          return null;
        }
        directories.set(path.normalize(absDir), { relativePath: relative, root });
        return listing;
      } catch {
        return null;
      }
    },
    readFile: (absFile) => {
      try {
        const lexicalDirectory = path.normalize(path.dirname(absFile));
        const directory = directories.get(lexicalDirectory);
        if (!directory) {
          return { ok: false, reason: 'unreadable' };
        }
        // Bound the read BEFORE pulling untrusted bytes into the main process:
        // a giant file would block main and (unbounded) balloon renderer memory
        // over IPC. The bound is a BYTE ceiling (MAX_USER_COMMAND_FILE_BYTES =
        // 4× the char cap), so a multi-byte file under the character cap is
        // never falsely rejected; a file above it is DEFINITIVELY oversized and
        // reported as such (honest reason — the loader logs a warn, not a
        // spurious "Failed to read"), never a blocking multi-hundred-MB read.
        const result = directory.root.readFile(
          path.join(directory.relativePath, path.basename(absFile)),
          MAX_USER_COMMAND_FILE_BYTES
        );
        if (result.status !== 'ok') {
          return {
            ok: false,
            reason: result.status === 'oversized' ? 'oversized' : 'unreadable',
          };
        }
        return { content: result.content.toString('utf8'), ok: true };
      } catch {
        return { ok: false, reason: 'unreadable' };
      }
    },
  };
}
