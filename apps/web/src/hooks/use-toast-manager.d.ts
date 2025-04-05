/**
 * Toast Manager Hook
 *
 * This hook provides a consistent interface for managing toasts in the file explorer.
 * It handles common toast patterns and error handling.
 */
import type { ToastActionElement } from '../components/ui/toast';
import { PartialRefreshError } from '../types/errors';
export declare const useToastManager: () => {
    toast: typeof import("../components/ui/use-toast").toast;
    showToast: ({ title, description, variant, action, }: {
        title: string;
        description: string;
        variant?: "default" | "destructive";
        action?: ToastActionElement;
    }) => void;
    handlePartialRefreshError: (error: PartialRefreshError) => void;
    handleRefreshError: (error: unknown) => void;
    handleBrowserCompatibilityError: (reason: string) => void;
    handleDirectorySelectError: (error: unknown) => void;
    handleSelectionLimitError: () => void;
};
//# sourceMappingURL=use-toast-manager.d.ts.map