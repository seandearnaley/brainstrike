import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { FileExplorerStrings } from './constants/file-explorer-constants';
export const FileExplorerHeader = () => {
    return (_jsxs("header", { className: "p-4 border-b bg-gradient-to-b from-background/60 to-background", children: [_jsx("h1", { className: "text-xl font-semibold tracking-tight", children: FileExplorerStrings.TITLE }), _jsx("p", { className: "text-sm text-muted-foreground mt-1", children: "Navigate and select files to include in your project" })] }));
};
