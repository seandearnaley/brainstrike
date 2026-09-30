import type { IFileNode } from '@brainstrike/types';
import { File as FileIcon, Folder, FolderOpen, Loader2 } from 'lucide-react';

interface NodeIconProps {
  isExpanded: boolean;
  isLoading: boolean;
  node: IFileNode;
}

export function NodeIcon({ node, isExpanded, isLoading }: NodeIconProps) {
  if (isLoading) {
    return (
      <Loader2 aria-label={`Loading ${node.name}`} className="animate-spin text-info" size={16} />
    );
  }

  if (node.type === 'file') {
    return <FileIcon className="text-muted-foreground" size={16} />;
  }

  if (node.type === 'directory') {
    return isExpanded ? (
      <FolderOpen className="text-blue-800 dark:text-blue-300" size={16} />
    ) : (
      <Folder className="text-blue-800 dark:text-blue-300" size={16} />
    );
  }

  return null;
}

export default NodeIcon;
