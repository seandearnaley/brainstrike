import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Folder } from 'lucide-react';
import { Badge } from '../../components/ui/badge';
import { cn } from '../../lib/utils';
import { getFolderColor } from '../../utils/color-utils';
export function FolderBadge({ folderId, className }) {
    const colors = getFolderColor(folderId);
    return (_jsxs(Badge, { variant: "secondary", className: cn('flex items-center gap-1 px-2 py-0.5 shrink-0 transition-colors', className), style: {
            '--folder-bg': colors.light.bg,
            '--folder-text': colors.light.text,
            '--folder-dark-bg': colors.dark.bg,
            '--folder-dark-text': colors.dark.text,
            backgroundColor: 'var(--folder-bg)',
            color: 'var(--folder-text)',
        }, children: [_jsx("style", { children: `
          :global(.dark) .badge {
            background-color: var(--folder-dark-bg) !important;
            color: var(--folder-dark-text) !important;
          }
        ` }), _jsx(Folder, { className: "h-3 w-3" }), _jsx("span", { className: "text-xs font-medium", children: folderId })] }));
}
