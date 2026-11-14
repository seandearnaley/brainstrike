import { rename } from 'node:fs/promises';
import path from 'node:path';

const E2E_TRASH_DIR_ENV = 'BRAINSTRIKE_E2E_TRASH_DIR' as const;

/** Test mode's Trash is the folder the E2E harness names, and it names none Main can use. */
export class E2eTrashDirectoryError extends Error {
  override readonly name = 'E2eTrashDirectoryError';
}

/**
 * ADR-0034: where Main moves a scratch folder it sends to the Trash (a deleted scratch thread's,
 * and every one Clear Database leaves). A shipped build uses the system Trash. Desktop E2E moves
 * the folder into the folder `BRAINSTRIKE_E2E_TRASH_DIR` names, read as the move runs, so no test
 * run puts a folder in the machine's Trash. When it names none, or a relative path, the move
 * throws and the folder stays: test mode never falls back to the system Trash.
 */
export function scratchTrashDestination(options: {
  readonly e2e: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly systemTrash: (folder: string) => Promise<void>;
}): (folder: string) => Promise<void> {
  if (!options.e2e) {
    return options.systemTrash;
  }
  return async (folder) => {
    const directory = options.env[E2E_TRASH_DIR_ENV];
    if (!directory) {
      throw new E2eTrashDirectoryError(
        `Test mode moves a trashed folder into the folder ${E2E_TRASH_DIR_ENV} names, and it names none.`
      );
    }
    if (!path.isAbsolute(directory)) {
      throw new E2eTrashDirectoryError(`${E2E_TRASH_DIR_ENV} must be an absolute path.`);
    }
    await rename(folder, path.join(directory, path.basename(folder)));
  };
}
