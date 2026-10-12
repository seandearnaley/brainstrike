/**
 * The indexer's trigram table and sync triggers (`packages/indexer/src/store.ts`)
 * for fixtures whose `file_chunks` omits the `pk` rowid alias; grep's trigram
 * candidates read this table.
 */
export const NATIVE_TRIGRAM_SCHEMA = `CREATE VIRTUAL TABLE file_chunks_trigram USING fts5(content,content='file_chunks',tokenize='trigram');
  CREATE TRIGGER chunks_insert AFTER INSERT ON file_chunks BEGIN
    INSERT INTO file_chunks_trigram(rowid,content) VALUES(new.rowid,new.content);
  END;
  CREATE TRIGGER chunks_delete AFTER DELETE ON file_chunks BEGIN
    INSERT INTO file_chunks_trigram(file_chunks_trigram,rowid,content) VALUES('delete',old.rowid,old.content);
  END;
  CREATE TRIGGER chunks_update AFTER UPDATE ON file_chunks BEGIN
    INSERT INTO file_chunks_trigram(file_chunks_trigram,rowid,content) VALUES('delete',old.rowid,old.content);
    INSERT INTO file_chunks_trigram(rowid,content) VALUES(new.rowid,new.content);
  END;`;
