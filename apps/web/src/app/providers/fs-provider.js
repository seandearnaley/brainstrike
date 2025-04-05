import { jsx as _jsx } from "react/jsx-runtime";
import FS from '@isomorphic-git/lightning-fs';
import { createContext, useContext, useEffect, useState } from 'react';
const FSContext = createContext({
    fs: null,
    isInitialized: false,
    error: null,
});
export const useFS = () => useContext(FSContext);
export const FSProvider = ({ children }) => {
    const [fs, setFS] = useState(null);
    const [isInitialized, setIsInitialized] = useState(false);
    const [error, setError] = useState(null);
    useEffect(() => {
        const initializeFS = async () => {
            try {
                // Check if we're in a browser environment
                if (typeof window === 'undefined') {
                    console.warn('Not initializing FS in non-browser environment');
                    return;
                }
                // Initialize the lightning-fs file system
                const lightningFS = new FS('brainstrike-fs');
                // Ensure the file system is ready by performing a test operation
                try {
                    // Try to access the root directory to verify the FS is working
                    await lightningFS.promises.mkdir('/test-init');
                    await lightningFS.promises.rmdir('/test-init');
                    console.log('File system initialized successfully');
                    setFS(lightningFS);
                    setIsInitialized(true);
                }
                catch (fsError) {
                    console.error('File system initialization test failed:', fsError);
                    throw fsError;
                }
            }
            catch (err) {
                console.error('Failed to initialize file system:', err);
                setError(err instanceof Error ? err : new Error('Unknown error initializing file system'));
            }
        };
        initializeFS();
        // Cleanup function
        return () => {
            // Any cleanup needed for the file system
            if (fs) {
                console.log('Cleaning up file system resources');
                // No explicit cleanup needed for lightning-fs, but good to have the hook
            }
        };
    }, [fs]); // Add fs to the dependency array
    return _jsx(FSContext.Provider, { value: { fs, isInitialized, error }, children: children });
};
