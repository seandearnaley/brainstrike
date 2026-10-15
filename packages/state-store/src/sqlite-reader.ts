// The desktop indexer's read-only truth reader: its own read-only connection to a data root's state DB, opened once
// the state DB exists. The reads themselves are `StateTruthReader`'s.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Db, openRo } from './sqlite.js';
import { StateTruthReader } from './state-truth-reader.js';

export {
  type MemoryObservationRecord,
  type MemoryThreadBinding,
  READ_LIMIT,
  type ReadItem,
  readAll,
} from './state-truth-reader.js';

export class SqliteReader extends StateTruthReader {
  readonly #file: { db: Db | null; readonly path: string };

  constructor(root: string) {
    const file: { db: Db | null; readonly path: string } = {
      db: null,
      path: join(root, 'state.db'),
    };
    super(() => {
      if (file.db && !existsSync(file.path)) {
        throw new Error('State truth database does not exist');
      }
      if (!file.db && existsSync(file.path)) {
        file.db = openRo(file.path);
      }
      return file.db;
    });
    this.#file = file;
  }

  /** The reader's own read-only connection, once the state DB exists. */
  private get db(): Db | null {
    return this.#file.db;
  }

  override close(): void {
    this.db?.close();
    this.#file.db = null;
  }
}
