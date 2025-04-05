import FS from '@isomorphic-git/lightning-fs';
import type React from 'react';
import { type ReactNode } from 'react';
interface FSContextType {
    fs: FS | null;
    isInitialized: boolean;
    error: Error | null;
}
export declare const useFS: () => FSContextType;
interface FSProviderProps {
    children: ReactNode;
}
export declare const FSProvider: React.FC<FSProviderProps>;
export {};
//# sourceMappingURL=fs-provider.d.ts.map