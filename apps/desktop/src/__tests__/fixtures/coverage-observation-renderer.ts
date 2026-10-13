import { indexSearchContract } from '../../ipc-domains/index-search.contract';
import { createIpcCapability } from '../../renderer/ipc-capability';

if (!window.indexSearch) {
  throw new Error('Coverage proof requires the production index-search transport.');
}
Object.defineProperty(window, '__brainstrikeTestHooks__', {
  value: { indexSearch: createIpcCapability(window.indexSearch, indexSearchContract) },
});
