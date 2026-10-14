import type {
  PromptVectorReply,
  PromptVectorRequest,
  PromptVectorState,
} from '@brainstrike/state-store';
import type Database from 'better-sqlite3';
import { decoder } from './contracts.js';
import { promptVectorReplySchema, promptVectorRequestSchema } from './prompt-vector-contract.js';
import { vectorBytes } from './state-message-vectors.js';

/** Derived prompt vectors live under the existing host state index writer and reset lease. */
export class PromptVectors {
  static readonly definition = `CREATE TABLE prompt_vectors (
 id TEXT PRIMARY KEY NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),
 emb BLOB CHECK(emb IS NULL OR length(emb)=384*4),error TEXT,updated_at TEXT NOT NULL,
 CHECK((emb IS NOT NULL AND error IS NULL) OR (emb IS NULL AND length(trim(error))>0))
 ) STRICT;`;
  constructor(private readonly db: Database.Database) {}
  execute(input: unknown): PromptVectorReply {
    const request: PromptVectorRequest = decoder(promptVectorRequestSchema)(input);
    return this.db.transaction(() => {
      switch (request.operation) {
        case 'status':
          return { hits: [], rows: this.status(request.items) };
        case 'delete':
          this.db
            .prepare('DELETE FROM prompt_vectors WHERE id IN (SELECT value FROM json_each(?))')
            .run(JSON.stringify(request.ids));
          return { hits: [], rows: [] };
        case 'put':
        case 'error': {
          const bytes = request.operation === 'put' ? vectorBytes(request.vector, 384) : null;
          this.db
            .prepare(
              'INSERT INTO prompt_vectors(id,revision,emb,error,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,emb=excluded.emb,error=excluded.error,updated_at=excluded.updated_at'
            )
            .run(
              request.id,
              request.revision,
              bytes,
              request.operation === 'error' ? request.error.trim() : null,
              new Date().toISOString()
            );
          return { hits: [], rows: this.status([request]) };
        }
        case 'similar': {
          const vector = vectorBytes(request.vector, 384);
          const hits = this.db
            .prepare(`SELECT id,revision,similarity FROM (
       SELECT p.id,p.revision,max(-1,min(1,1-vec_distance_cosine(p.emb,?))) AS similarity
       FROM prompt_vectors p JOIN json_each(?) wanted ON p.id=json_extract(wanted.value,'$.id') AND p.revision=json_extract(wanted.value,'$.revision')
       WHERE p.emb IS NOT NULL AND p.error IS NULL
       ) WHERE similarity>=? ORDER BY similarity DESC,id LIMIT ?`)
            .all(vector, JSON.stringify(request.items), request.threshold, request.limit);
          return decoder(promptVectorReplySchema)({ hits, rows: [] });
        }
      }
    })();
  }
  private status(items: readonly { id: string; revision: number }[]): readonly PromptVectorState[] {
    return decoder(promptVectorReplySchema)({
      hits: [],
      rows: this.db
        .prepare(
          `SELECT p.id,p.revision,p.error,p.updated_at AS updatedAt FROM prompt_vectors p JOIN json_each(?) wanted ON p.id=json_extract(wanted.value,'$.id') AND p.revision=json_extract(wanted.value,'$.revision') ORDER BY p.id`
        )
        .all(JSON.stringify(items)),
    }).rows;
  }
}
