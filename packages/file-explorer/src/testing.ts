// E2E-facing seam. Import THIS entrypoint (not the package root) from Playwright
// suites: the root barrel re-exports the store, which creates the zustand
// persist store as a module-load side effect — safe in Node, but an entire
// runtime graph loaded for what tests actually need here.
export {
  FILE_EXPLORER_STORAGE_KEY,
  FILE_EXPLORER_STORAGE_VERSION,
} from './persistence/persistence-constants';
// Internal persistence detail, exposed here (not from the package root) so E2E
// suites can seed stored explorer state without widening the public API.
export { serializeState } from './persistence/state-serialization';
