/**
 * Ambient File System Access API types (queryPermission/requestPermission,
 * showDirectoryPicker, FileSystemObserver). lib.dom does not declare them; the
 * handle-permission code across the file-explorer and notes packages relies on
 * this global augmentation being part of every program that imports this
 * package.
 */
// Type declarations for File System Access API
declare global {
  interface Window {
    showDirectoryPicker(): Promise<FileSystemDirectoryHandle>;
  }

  interface FileSystemDirectoryHandle extends FileSystemHandle {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    getDirectoryHandle(
      name: string,
      options?: { create?: boolean }
    ): Promise<FileSystemDirectoryHandle>;
    getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
    readonly kind: 'directory';
    readonly name: string;
  }

  interface FileSystemFileHandle extends FileSystemHandle {
    getFile(): Promise<File>;
    readonly kind: 'file';
    readonly name: string;
  }

  interface FileSystemHandle {
    readonly kind: 'file' | 'directory';
    readonly name: string;
    queryPermission?(descriptor?: FileSystemPermissionDescriptor): Promise<PermissionState>;
    requestPermission?(descriptor?: FileSystemPermissionDescriptor): Promise<PermissionState>;
  }

  interface FileSystemPermissionDescriptor {
    mode?: 'read' | 'readwrite';
  }

  /**
   * Minimal ambient type for the WICG FileSystemObserver draft (Chrome 133+,
   * behind the File System Observer Origin Trial / experimental flag).
   * No lib.dom types exist for this API yet; these declarations mirror the
   * spec at https://github.com/WICG/file-system-observer.
   *
   * Keep in sync with the WICG draft shape; update when the API ships in
   * stable DOM typings.
   *
   * Pattern: interface (instance type) + var (constructor value) is the
   * standard TypeScript idiom for declaring a constructable global without
   * the class keyword, avoiding OXC "already declared" parse errors that
   * arise when combining `class` + `var` in the same declare-global block.
   */
  interface FileSystemObserverRecord {
    /** Null for records that cannot surface a handle (gone entries, errored/unknown). */
    readonly changedHandle: FileSystemHandle | null;
    /** Null for errored/unknown records that carry no location. */
    readonly relativePathComponents: readonly string[] | null;
    /** For 'moved' records: the previous path relative to root, else null. */
    readonly relativePathMovedFrom: readonly string[] | null;
    readonly root: FileSystemDirectoryHandle;
    readonly type: 'appeared' | 'disappeared' | 'errored' | 'modified' | 'moved' | 'unknown';
  }

  type FileSystemObserverCallback = (
    records: FileSystemObserverRecord[],
    observer: FileSystemObserver
  ) => void;

  interface FileSystemObserver {
    disconnect(): void;
    observe(
      handle: FileSystemDirectoryHandle,
      options?: { recursive?: boolean }
    ): void | Promise<void>;
  }

  // Exposes the constructor as a value on globalThis for typeof feature detection.
  // This is a TypeScript ambient `var` declaration (no runtime effect — the var
  // keyword here is a TypeScript idiom for declaring a constructable global in
  // a declare-global block; it does not produce a real var statement in output).
  var FileSystemObserver: {
    new (callback: FileSystemObserverCallback): FileSystemObserver;
  };
}

export {};
