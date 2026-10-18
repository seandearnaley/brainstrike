/** What the agent host's state store found when it opened (BST-1880). */
export interface StateStoreHealth {
  /** Conversations the host could not read; each also lists as damaged. */
  readonly damagedThreads: number;
  /** The integrity failure when the state DB opened damaged and read-only; null when healthy. */
  readonly stateDamage: string | null;
}

/**
 * The shell's view of its canonical state store and how to recover it. Desktop
 * supplies it; where it is absent, the damaged-store notice never renders.
 */
export interface StateHealthCapability {
  /**
   * Re-reads the store's health as the running host sees it; null when that host
   * cannot report it (an older build left running), which is not a claim of health.
   */
  read(): Promise<StateStoreHealth | null>;
  /** Restarts the agent host, so its store reopens and checks itself again. */
  restartHost(): Promise<void>;
  /** Opens the profile's data folder in the OS file manager. */
  showDataFolder(): Promise<void>;
}
