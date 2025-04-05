import { useState } from 'react';
import { useFileExplorerStore } from '../stores/use-file-explorer-store';
export function useFileSystem() {
    const [rootDirectoryHandle, setRootDirectoryHandle] = useState(null);
    const [isAccessLoading, setIsAccessLoading] = useState(false);
    const { setCurrentFolderId } = useFileExplorerStore();
    const isFileSystemAccessSupported = () => {
        if (!window.isSecureContext) {
            return {
                supported: false,
                reason: 'File System Access API requires a secure context (HTTPS)',
            };
        }
        if (typeof window.showDirectoryPicker !== 'function') {
            return {
                supported: false,
                reason: 'File System Access API is not supported in this browser',
            };
        }
        return { supported: true, reason: '' };
    };
    const selectRootDirectory = async () => {
        const { supported, reason } = isFileSystemAccessSupported();
        if (!supported) {
            throw new Error(reason);
        }
        setIsAccessLoading(true);
        try {
            const handle = await window.showDirectoryPicker();
            setRootDirectoryHandle(handle);
            setCurrentFolderId(handle.name);
            return handle;
        }
        catch (error) {
            if (error instanceof Error) {
                if (error.name === 'SecurityError') {
                    throw new Error('Permission denied');
                }
                if (error.name === 'AbortError') {
                    return null;
                }
            }
            throw error;
        }
        finally {
            setIsAccessLoading(false);
        }
    };
    return {
        rootDirectoryHandle,
        isAccessLoading,
        selectRootDirectory,
        isFileSystemAccessSupported,
    };
}
