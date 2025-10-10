import type { FileChunk, FileRecord, useClearAllData } from '@brainstrike/db';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@brainstrike/ui';
import { Trash2 } from 'lucide-react';

interface ClearDatabaseDialogProps {
  clearAllData: ReturnType<typeof useClearAllData>;
  records: FileRecord[];
  chunks: FileChunk[];
  clearing: boolean;
  showClearDialog: boolean;
  setShowClearDialog: (show: boolean) => void;
  onClear: () => Promise<void>;
}

export function ClearDatabaseDialog({
  clearAllData,
  records,
  chunks,
  clearing,
  showClearDialog,
  setShowClearDialog,
  onClear,
}: ClearDatabaseDialogProps) {
  return (
    <Dialog open={showClearDialog} onOpenChange={setShowClearDialog}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="destructive"
          disabled={clearing || !clearAllData || (records.length === 0 && chunks.length === 0)}
          className="flex items-center gap-1"
        >
          <Trash2 className="h-3 w-3" />
          Clear Database
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Clear Database</DialogTitle>
          <DialogDescription>
            This will permanently delete all imported files ({records.length}) and chunks (
            {chunks.length}) from the database. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setShowClearDialog(false)} disabled={clearing}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onClear} disabled={clearing}>
            {clearing ? 'Clearing...' : 'Clear Database'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
