import type { IFileNode } from '@/lib/file/types';
interface FolderSelectionDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    node: IFileNode;
    fileCount: number;
    onConfirm: () => void;
    onToggleFileSelection: (path: string) => void;
}
export declare function FolderSelectionDialog({ open, onOpenChange, node, fileCount, onConfirm, onToggleFileSelection, }: FolderSelectionDialogProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=folder-selection-dialog.d.ts.map