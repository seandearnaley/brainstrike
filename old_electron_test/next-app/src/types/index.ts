export type FileContents = Record<string, string>;

// Electron API type definitions
interface ElectronAPI {
  getVersion: () => string;
  platform: string;
  isElectron: boolean;
  
  // File system operations
  pickDirectory: () => Promise<string | null>;
  listDirectory: (dirPath: string) => Promise<{ 
    success?: boolean; 
    files?: Array<{
      name: string;
      path: string;
      type: 'file' | 'directory';
      size: number;
      lastModified: number;
    }>;
    error?: string;
  }>;
  readFile: (filePath: string) => Promise<{
    data?: string;
    error?: string;
  }>;
}

// Add Electron API to Window interface
declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
