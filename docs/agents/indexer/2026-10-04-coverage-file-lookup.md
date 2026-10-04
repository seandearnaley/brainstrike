# Coverage file lookup

Scoped coverage recomputes authorized counts and validates storage in its existing read transaction. A leading canonical file-ID index supports that count join for both workspace and collection scopes. Schema7 uses the existing explicit derived-only rebuild policy; schema6 refuses without migrating or deleting the original store.

The final private VECTOR1000 diagnostic on1956c8c captured the actual loaded reader/writer. Reader selectedCounts occupied69.6 sampled seconds and coverage integrity validation60.3 sampled seconds;495 synchronous validations totaled63.5 seconds wall time. These are separate overlapping stack/wall measures, not interchangeable CPU counters. The existing chunks index begins with root_id, while selectedCounts joins by file_record_id alone.

Add only chunks_file_record(file_record_id). Keep the query, transaction, freshly computed counts and every authority/profile/binding/corruption guard unchanged. No coverage cache, inference/model tuning or scan-scheduling change is included. Native integration captures the actual production count SQL for EXPLAIN, removes the index as a causal negative control, compares results, and qualifies old-schema refusal and explicit fresh rebuild.

Validation remains a separate measured cost. The unchanged acceptance targets are vector throughput greater than213chunks/s and loaded native-tool p95 no more than twice same-run idle. This lookup correction alone makes no performance or M2 qualification claim.
