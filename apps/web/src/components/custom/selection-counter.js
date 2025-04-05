import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { Badge } from '../../components/ui/badge';
import { useFileExplorerStore } from '../../stores/use-file-explorer-store';
export const SelectionCounter = ({ maxSelections }) => {
    const { selectedFilePaths } = useFileExplorerStore();
    const selectedCount = selectedFilePaths.size;
    return (_jsx("output", { children: _jsxs(Badge, { variant: selectedCount === maxSelections ? 'destructive' : 'secondary', className: "whitespace-nowrap text-xs sm:text-sm", children: [selectedCount, "/", maxSelections] }) }));
};
