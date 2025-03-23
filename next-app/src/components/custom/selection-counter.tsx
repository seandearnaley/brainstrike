import { Badge } from '@/components/ui/badge';
import { useFileExplorerStore } from '@/stores/use-file-explorer-store';
import type React from 'react';

interface SelectionCounterProps {
  maxSelections: number;
}

export const SelectionCounter: React.FC<SelectionCounterProps> = ({ maxSelections }) => {
  const { selectedFilePaths } = useFileExplorerStore();
  const selectedCount = selectedFilePaths.size;

  return (
    <output>
      <Badge
        variant={selectedCount === maxSelections ? 'destructive' : 'secondary'}
        className="whitespace-nowrap text-xs sm:text-sm"
      >
        {selectedCount}/{maxSelections}
      </Badge>
    </output>
  );
};
