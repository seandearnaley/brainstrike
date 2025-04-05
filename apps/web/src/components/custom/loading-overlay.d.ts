import type { LoadingProgressState } from '@/hooks/use-file-tree';
import * as React from 'react';
export interface LoadingOverlayProps extends React.HTMLAttributes<HTMLDivElement> {
    isLoading: boolean;
    isInitialLoad?: boolean;
    progressLoaded?: number;
    progressTotal?: number;
    progressState?: LoadingProgressState;
    message?: string;
    description?: string;
}
export declare const LoadingOverlay: React.ForwardRefExoticComponent<LoadingOverlayProps & React.RefAttributes<HTMLDivElement>>;
//# sourceMappingURL=loading-overlay.d.ts.map