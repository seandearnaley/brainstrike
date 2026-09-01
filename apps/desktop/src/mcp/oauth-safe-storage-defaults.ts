import { safeStorage } from 'electron';
import ElectronStore from 'electron-store';
import {
  createSafeStorageMcpOAuthStore,
  type EncryptedStoreSchema,
  type McpOAuthStore,
} from './oauth-client-provider';

export function createDefaultSafeStorageMcpOAuthStore(): McpOAuthStore {
  const store = new ElectronStore<EncryptedStoreSchema>({ name: 'brainstrike-mcp-oauth' });
  return createSafeStorageMcpOAuthStore(store, safeStorage);
}
