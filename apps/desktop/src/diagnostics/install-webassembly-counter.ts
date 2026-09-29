// Side-effect module: imported FIRST by main.ts so every later import that
// touches WebAssembly (PGlite, xxhash-wasm, tokenizers) is counted. Biome keeps
// a bare side-effect import in place, so the ordering survives import sorting.
// `installWebAssemblyCounter()` is idempotent: main.ts reads the same counter
// back through a later (sorted) named import.
import { installWebAssemblyCounter } from './webassembly-counter';

installWebAssemblyCounter();
