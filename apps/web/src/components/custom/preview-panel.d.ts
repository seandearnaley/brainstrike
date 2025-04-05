import React from 'react';
interface PreviewPanelProps {
    selectedFiles: Set<string>;
    fileContents: {
        [compositeKey: string]: string;
    };
    loadingFiles: Set<string>;
    onSelectionChange: (files: Set<string>) => void;
    fileSizes?: {
        [compositeKey: string]: number;
    };
}
export declare const PreviewPanel: React.FC<PreviewPanelProps>;
export {};
//# sourceMappingURL=preview-panel.d.ts.map