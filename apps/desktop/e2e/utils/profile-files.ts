import { readdirSync } from 'node:fs';
import path from 'node:path';

/** The one file of this name in the profile under `userDataDir`, such as `state.db` or `index.sqlite`. */
export function profileFile(userDataDir: string, name: string): string {
  const found = readdirSync(userDataDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === name)
    .map((entry) => path.join(entry.parentPath, entry.name));
  if (found.length !== 1) {
    throw new Error(`Expected one ${name}, found: ${JSON.stringify(found)}`);
  }
  return found[0] as string;
}
