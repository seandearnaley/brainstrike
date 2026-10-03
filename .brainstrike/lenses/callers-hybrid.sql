-- description: Hybrid retrieval over a symbol's caller graph — traverse transitive callers, then rank the reachable files' chunks with the BM25 and vector arms, RRF-fused (BST-935 canonical statement)
-- target: app
-- param: symbol text  Seed symbol name, e.g. startEmbeddingWorker (exact match against file_symbols.name)
-- param: terms text   BM25 search terms as prose words (english config does not split camelCase identifiers)
WITH RECURSIVE callers(file_record_id, seq, name, depth) AS (
  SELECT s.file_record_id, s.seq, s.name, 0
  FROM file_symbols s WHERE s.name = $1
  UNION
  SELECT encl.file_record_id, encl.seq, encl.name, c.depth + 1
  FROM callers c
  JOIN file_symbol_refs r ON r.name = c.name AND r.kind = 'call'
  JOIN file_symbols encl
    ON encl.file_record_id = r.file_record_id AND encl.seq = r.from_symbol_seq
  WHERE c.depth < 10
),
reachable AS (SELECT DISTINCT file_record_id FROM callers),
seed_embedding AS (
  SELECT ch.embedding, ch.embedding_set_id
  FROM file_chunks ch
  JOIN file_symbols s ON s.file_record_id = ch.file_record_id
  WHERE s.name = $1
    AND ch.start_line <= s.start_line AND ch.end_line >= s.start_line
    AND ch.embedding IS NOT NULL
  ORDER BY ch.id LIMIT 1
),
bm25_arm AS (
  SELECT ch.id, ROW_NUMBER() OVER (
    ORDER BY (-(ch.content <@> to_bm25query($2, 'idx_file_chunks_content_bm25')))::float8
             DESC NULLS LAST, ch.id
  ) AS position
  FROM file_chunks ch
  JOIN reachable rf ON rf.file_record_id = ch.file_record_id
  WHERE ch.content_tsvector IS NOT NULL
    AND ch.content_tsvector @@ websearch_to_tsquery('english', $2)
  ORDER BY 2
  LIMIT 50
),
vector_arm AS (
  SELECT ch.id, ROW_NUMBER() OVER (
    ORDER BY ch.embedding <=> (SELECT embedding FROM seed_embedding), ch.id
  ) AS position
  FROM file_chunks ch
  JOIN reachable rf ON rf.file_record_id = ch.file_record_id
  WHERE ch.embedding IS NOT NULL
    AND ch.embedding_set_id IS NOT DISTINCT FROM (SELECT embedding_set_id FROM seed_embedding)
  ORDER BY 2
  LIMIT 50
)
SELECT fr.path, ch.id AS chunk_id, ch.start_line, ch.end_line,
       sum(1.0 / (60 + arm.position))::float8 AS rrf_score
FROM (
  SELECT id, position FROM bm25_arm
  UNION ALL
  SELECT id, position FROM vector_arm
) arm
JOIN file_chunks ch ON ch.id = arm.id
JOIN file_records fr ON fr.id = ch.file_record_id
GROUP BY fr.path, ch.id, ch.start_line, ch.end_line
ORDER BY rrf_score DESC, fr.path
