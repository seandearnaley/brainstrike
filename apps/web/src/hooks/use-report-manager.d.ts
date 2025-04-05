/**
 * Report Manager Hook
 *
 * This hook manages report generation and export functionality.
 * It handles generating reports and exporting them in various formats.
 */
import type { ToastActionElement } from '../components/ui/toast';
interface UseReportManagerProps {
    rootDirectoryHandle: FileSystemDirectoryHandle | null;
    generateReportWithContent: () => Promise<string>;
    showToast: (props: {
        title: string;
        description: string;
        variant?: 'default' | 'destructive';
        action?: ToastActionElement;
    }) => void;
    toast: (props: {
        title: string;
        description: string;
        variant?: 'default' | 'destructive';
        action?: ToastActionElement;
        duration?: number;
    }) => {
        dismiss?: () => void;
    };
}
export declare const useReportManager: ({ rootDirectoryHandle, generateReportWithContent, showToast, toast, }: UseReportManagerProps) => {
    handleDownloadReport: () => Promise<void>;
    handleCopyReport: () => Promise<void>;
};
export {};
//# sourceMappingURL=use-report-manager.d.ts.map