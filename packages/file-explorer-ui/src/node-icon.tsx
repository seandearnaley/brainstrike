import type { IFileNode } from '@brainstrike/types';
import { File as FileIcon, Folder, FolderOpen, Loader2 } from 'lucide-react';

interface NodeIconProps {
  node: IFileNode;
  isExpanded: boolean;
  isLoading: boolean;
}

export function NodeIcon({ node, isExpanded, isLoading }: NodeIconProps) {
  if (isLoading) {
    return (
      <Loader2
        size={16}
        className="text-blue-500 dark:text-blue-400 animate-spin"
        aria-label={`Loading ${node.name}`}
      />
    );
  }

  if (node.type === 'file') {
    return <FileIcon size={16} className="text-gray-500 dark:text-gray-400" />;
  }

  if (node.type === 'directory') {
    return isExpanded ? (
      <FolderOpen size={16} className="text-blue-500 dark:text-blue-400" />
    ) : (
      <Folder size={16} className="text-blue-500 dark:text-blue-400" />
    );
  }

  return null;
}

export default NodeIcon;
