export interface ThreadCheckoutRoot {
  readonly displayName: string;
  readonly path?: string | undefined;
  readonly rootId: string;
}

export interface ThreadCheckoutFolders {
  readonly checkoutLocalRootId: string | undefined;
  readonly checkoutMode: 'local' | 'worktree';
  readonly metadataPending: boolean;
  readonly primaryRoot: ThreadCheckoutRoot | undefined;
  readonly primaryRootId: string | undefined;
  readonly secondaryRootIds: readonly string[];
  readonly secondaryRoots: readonly ThreadCheckoutRoot[];
  readonly secondaryRootsError: boolean;
  readonly secondaryRootsPending: boolean;
  readonly threadId: string | undefined;
}

export interface ThreadCheckoutWrite {
  readonly binding?: Record<string, string>;
  readonly checkoutLocalRootId: string | undefined;
  readonly ids: readonly string[];
  readonly primaryRoot: ThreadCheckoutRoot | undefined;
  readonly primaryRootId: string | undefined;
  readonly secondaryRoots: readonly ThreadCheckoutRoot[];
}
