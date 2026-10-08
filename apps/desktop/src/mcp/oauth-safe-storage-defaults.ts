import {
  createSafeStorageMcpOAuthStore,
  type EncryptedStoreSchema,
  type McpOAuthStore,
} from '@brainstrike/host-capabilities/mcp/oauth-client-provider';
import { safeStorage } from 'electron';
import ElectronStore from 'electron-store';

export function createDefaultSafeStorageMcpOAuthStore(): McpOAuthStore {
  const store = new ElectronStore<EncryptedStoreSchema>({ name: 'brainstrike-mcp-oauth' });
  return createSafeStorageMcpOAuthStore(store, safeStorage);
}
