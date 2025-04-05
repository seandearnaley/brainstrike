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
                // Initialize the lightning-fs file system
                const lightningFS = new FS('brainstrike-fs');
                // Ensure the file system is ready
                await new Promise((resolve) => {
                    setTimeout(() => {
                        setFS(lightningFS);
                        setIsInitialized(true);
                        resolve();
                    }, 100); // Small delay to ensure initialization
                });
                console.log('File system initialized successfully');
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
        };
    }, []);
    return _jsx(FSContext.Provider, { value: { fs, isInitialized, error }, children: children });
};
