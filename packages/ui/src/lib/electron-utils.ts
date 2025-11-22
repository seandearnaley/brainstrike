import type { LayoutElectronAPI } from '../types/electron';

type WindowWithElectronAPI = {
  electronAPI?: LayoutElectronAPI;
};

export const getElectronAPI = (): LayoutElectronAPI | undefined => {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as WindowWithElectronAPI).electronAPI;
};

export const hasElectronAPI = (): boolean => {
  return !!getElectronAPI();
};
