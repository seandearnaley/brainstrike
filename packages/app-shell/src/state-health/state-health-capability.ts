/** What the agent host's state store found when it opened (BST-1880). */
export interface StateStoreHealth {
  /** The integrity failure when the state DB opened damaged and read-only; null when healthy. */
  readonly stateDamage: string | null;
  /** Records the store could not read; never their contents. */
  readonly unreadableRecords: number;
}

/**
 * The shell's view of its canonical state store and how to recover it. Desktop
 * supplies it; where it is absent, the damaged-store notice never renders.
 */
export interface StateHealthCapability {
  /** Re-reads the store's health as the running host sees it. */
  read(): Promise<StateStoreHealth>;
  /** Restarts the agent host, so its store reopens and checks itself again. */
  restartHost(): Promise<void>;
  /** Opens the profile's data folder in the OS file manager. */
  showDataFolder(): Promise<void>;
}
