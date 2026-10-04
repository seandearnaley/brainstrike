-- description: Hybrid retrieval over a symbol's caller graph — traverse transitive callers, then rank the reachable files' chunks with the BM25 and vector arms, RRF-fused (BST-935 canonical statement)
-- target: index
-- requires: caller-vectors symbol
-- param: symbol text  Seed symbol name, e.g. startEmbeddingWorker (exact match against file_symbols.name)
-- param: terms text   FTS5 MATCH expression (porter unicode61 tokenizer; identifiers are not camelCase-split)
-- Trusted reader bindings are internal; the public symbol/terms params remain unchanged.
WITH RECURSIVE authorized_files AS (
  SELECT id FROM file_records
  WHERE scoped=1 AND embedding_set_id=$brainstrike_collection
    AND id IN (SELECT value FROM json_each($brainstrike_files))
), callers(file_record_id, seq, name, depth) AS (
  SELECT s.file_record_id, s.seq, s.name, 0
  FROM file_symbols s JOIN authorized_files a ON a.id=s.file_record_id WHERE s.name = $1
  UNION
  SELECT encl.file_record_id, encl.seq, encl.name, c.depth + 1
  FROM callers c
  JOIN file_symbol_refs r ON r.name = c.name AND r.kind = 'call'
  JOIN file_symbols encl
    ON encl.file_record_id = r.file_record_id AND encl.seq = r.from_symbol_seq
  JOIN authorized_files a ON a.id=encl.file_record_id
  WHERE c.depth < 10
),
reachable AS (SELECT DISTINCT file_record_id FROM callers),
seed_embedding AS MATERIALIZED (
  SELECT v.emb
  FROM file_chunks ch
  JOIN file_symbols s ON s.file_record_id = ch.file_record_id
  JOIN scoped_vectors v ON v.chunk_pk = ch.pk AND v.profile_hash = $brainstrike_profile
  WHERE s.name = $1
    AND ch.start_line <= s.start_line AND ch.end_line >= s.start_line
    AND s.file_record_id IN (SELECT id FROM authorized_files)
  ORDER BY ch.id LIMIT 1
),
-- Materialize FTS auxiliary scores before window evaluation.
bm25_scores AS MATERIALIZED (
  SELECT ch.id, bm25(file_chunks_fts) AS score
  FROM file_chunks_fts
  JOIN file_chunks ch ON ch.pk = file_chunks_fts.rowid
  JOIN reachable rf ON rf.file_record_id = ch.file_record_id
  WHERE file_chunks_fts MATCH $2
  ORDER BY score, ch.id
  LIMIT 50
),
bm25_arm AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY score, id) AS position
  FROM bm25_scores
),
vector_scores AS MATERIALIZED (
  SELECT ch.id, vec_distance_cosine(vec_f32(v.emb), vec_f32(seed.emb)) AS distance
  FROM file_chunks ch
  JOIN reachable rf ON rf.file_record_id = ch.file_record_id
  JOIN scoped_vectors v ON v.chunk_pk = ch.pk AND v.profile_hash = $brainstrike_profile
  CROSS JOIN seed_embedding seed
  WHERE v.content_hash = ch.content_hash
  ORDER BY distance, ch.id
  LIMIT 50
),
vector_arm AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY distance, id) AS position
  FROM vector_scores
)
SELECT fr.path, ch.id AS chunk_id, ch.start_line, ch.end_line,
       sum(1.0 / (60 + arm.position)) AS rrf_score
FROM (
  SELECT id, position FROM bm25_arm
  UNION ALL
  SELECT id, position FROM vector_arm
) arm
JOIN file_chunks ch ON ch.id = arm.id
JOIN file_records fr ON fr.id = ch.file_record_id
GROUP BY fr.path, ch.id, ch.start_line, ch.end_line
ORDER BY rrf_score DESC, fr.path, ch.id
