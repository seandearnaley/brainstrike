export interface ExternalElectronAPI {
  readonly invoke: () => Promise<void>;
}
