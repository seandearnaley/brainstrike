import type { LayoutElectronAPI } from '../types/electron';

interface WindowWithElectronAPI {
  electronAPI?: LayoutElectronAPI;
}

export const getElectronAPI = (): LayoutElectronAPI | undefined => {
  if (typeof window === 'undefined') {
    return;
  }
  return (window as WindowWithElectronAPI).electronAPI;
};
