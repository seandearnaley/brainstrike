import type { LayoutElectronAPI } from '../types/electron';

interface WindowWithElectronAPI {
  electronAPI?: LayoutElectronAPI;
}

export const getElectronAPI = (): LayoutElectronAPI | undefined => {
  if (typeof window === 'undefined') return undefined;
  return (window as WindowWithElectronAPI).electronAPI;
};

export const hasElectronAPI = (): boolean => {
  return !!getElectronAPI();
};
