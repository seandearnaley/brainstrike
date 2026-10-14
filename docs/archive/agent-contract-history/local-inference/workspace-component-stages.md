# Workspace component stages

The component stage API is mounted on both indexing paths and checks the selected
measurement capability rather than ingestion-service readiness.

BST-1974: the native desktop capability unmounts the legacy collection sync
provider, which owned the old debug snapshot and benchmark method. The outstanding
stage case consequently waited for a producer that could never mount. The new
opt-in renderer surface delegates unchanged to the production stage runner. DB
completion still measures the PGlite JobQueue completion transaction, managed
import still uses the managed-cache batch boundary, and chunking/query embedding
still execute through their hidden renderer hosts. None is a native SQLite corpus
benchmark. No 213 chunks/s threshold or benchmark timeout has been added.
