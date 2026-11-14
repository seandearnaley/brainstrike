/** ADR-0040: project memory, the plain files the host keeps for each project. */

export {
  type ProjectMemoryStore,
  projectMemorySection,
  type RunProjectMemory,
  readRunProjectMemory,
} from './memory-admission.ts';
export {
  loadedMemoryIndex,
  MEMORY_INDEX_MAX_CHARS,
  MEMORY_INDEX_MAX_LINES,
} from './memory-index.ts';
export {
  ProjectMemoryNotes,
  ProjectMemoryRefusal,
  type ProjectMemoryResult,
  projectMemoryFolder,
  removeProjectMemory,
} from './memory-notes.ts';
export { MEMORY_INDEX_FILE, MEMORY_ROOT } from './memory-paths.ts';
export { hostProjectMemory, runProjectMemoryTool } from './memory-tool.ts';
