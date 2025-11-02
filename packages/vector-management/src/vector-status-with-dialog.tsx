import { useState } from 'react';
import { ManageEmbeddingSetsDialog } from './embedding-set-management';
import { VectorStatusWithDb } from './vector-status';

/**
 * Wrapper component that adds the ManageEmbeddingSetsDialog to VectorStatusWithDb.
 * This is separated to avoid circular dependency issues with @brainstrike/db imports.
 */
export function VectorStatusWithDialog() {
  const [manageDialogOpen, setManageDialogOpen] = useState(false);

  return (
    <>
      <VectorStatusWithDb onManageEmbeddingSets={() => setManageDialogOpen(true)} />
      {/* Dialog will only mount when opened */}
      {manageDialogOpen && (
        <ManageEmbeddingSetsDialog
          open={manageDialogOpen}
          onOpenChange={setManageDialogOpen}
          db={null} // Will be accessed from context inside dialog
          repository={null} // Will be created inside dialog
          onSetSelected={() => {
            setManageDialogOpen(false);
          }}
        />
      )}
    </>
  );
}
