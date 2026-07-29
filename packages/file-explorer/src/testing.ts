export { FILE_EXPLORER_STORAGE_KEY } from './persistence/persistence-constants';
// Internal persistence detail, exposed here (not from the package root) so E2E
// suites can seed stored explorer state without widening the public API.
export { serializeState } from './persistence/state-serialization';
