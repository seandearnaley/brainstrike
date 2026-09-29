export namespace NestedDesktopBoundaryLeak {
  export interface DesktopElectronAPI {
    ping(): Promise<void>;
  }

  // biome-ignore lint/style/useConsistentTypeDefinitions: the negative control must exercise a type alias.
  export type DesktopElectronApi = {
    ping(): Promise<void>;
  };

  // biome-ignore lint/style/useConsistentTypeDefinitions: the negative control must exercise an exported object alias.
  export type ExportedDesktopPlatformAlias = {
    electronAPI?: DesktopElectronApi;
  };

  export const exportedDesktopPlatformObject: ExportedDesktopPlatformAlias = {};

  export interface Window extends ExportedDesktopPlatformAlias {}
}
