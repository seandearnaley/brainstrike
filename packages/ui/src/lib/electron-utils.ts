import type { LayoutElectronAPI } from '../types/electron';

type WindowWithElectronAPI = {
  electronAPI?: LayoutElectronAPI;
};

export const getElectronAPI = (): LayoutElectronAPI | undefined => {
  if (typeof window === 'undefined') {
    return;
  }
  return (window as WindowWithElectronAPI).electronAPI;
};

export const hasElectronAPI = (): boolean => !!getElectronAPI();
