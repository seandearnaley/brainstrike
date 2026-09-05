import type { Migration } from './migration-runner';

/**
 * Migration 023: Fix 'local' provider is_enabled state
 *
 * Migration 021 had a bug where it didn't copy is_enabled from the 'transformers'
 * provider when creating 'local'. This resulted in the 'local' provider being
 * disabled by default, which prevented users from toggling local models in settings
 * and caused local embedding models to not appear in the collection dropdown.
 *
 * This migration fixes the issue by enabling the 'local' provider.
 */
export const migration023FixLocalProviderEnabled: Migration = {
  down: `
    -- Revert to disabled state (though this is not the intended final state)
    UPDATE providers SET is_enabled = false WHERE id = 'local';
  `,
  ledgerKey: 'custom-023-fix-local-provider-enabled',
  name: 'fix_local_provider_enabled',
  up: `
    -- Enable the 'local' provider (was supposed to inherit is_enabled from 'transformers')
    UPDATE providers SET is_enabled = true, sort_order = 4, updated_at = NOW() WHERE id = 'local';
  `,
  version: 23,
};
