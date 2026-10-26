'use strict';

const bindings = require('bindings');

const {
  ExclusiveLock: NativeExclusiveLock,
  SecureRoot: NativeSecureRoot,
  applyPrivateDirectorySync,
  killWithParent,
  markDescriptorsCloseOnExec,
  setDefaultOwnerToCurrentUserSync,
  verifyPrivateDirectorySync,
} = bindings({
  bindings: 'secure_fs_native',
  ['module_root']: __dirname,
});

class SecureRoot {
  #canonicalPath;
  #native;

  constructor(rootPath) {
    // The native layer is the only resolver: it opens the root (following
    // symlinks for root establishment only) and derives canonical identity
    // from the opened handle. No path-based pre-resolution happens here.
    this.#native = new NativeSecureRoot(rootPath);
    this.#canonicalPath = this.#native.canonicalPath();
  }

  get canonicalPath() {
    return this.#canonicalPath;
  }

  close() {
    this.#native.close();
  }

  listDir(relativePath, maxEntries) {
    return this.#native.listDir(relativePath, maxEntries);
  }

  listDirAsync(relativePath, maxEntries) {
    return this.#native.listDirAsync(relativePath, maxEntries);
  }

  readFile(relativePath, maxBytes) {
    return this.#native.readFile(relativePath, maxBytes);
  }

  readFileAsync(relativePath, maxBytes) {
    return this.#native.readFileAsync(relativePath, maxBytes);
  }

  readPrivateFileAsync(relativePath) {
    return this.#native.readPrivateFileAsync(relativePath);
  }

  writePrivateFileAsync(relativePath, content) {
    return this.#native.writePrivateFileAsync(relativePath, content);
  }
}

class ExclusiveLock {
  #native;

  constructor(native) {
    this.#native = native;
  }

  release() {
    this.#native.release();
  }
}

/** The exclusive lock on `lockPath`, or null while another handle holds it. */
function tryExclusiveLock(lockPath) {
  const native = new NativeExclusiveLock(lockPath);
  return native.held() ? new ExclusiveLock(native) : null;
}

/** The exclusive lock on `lockPath`, once no other handle holds it: the OS wakes the wait. */
async function waitForExclusiveLock(lockPath) {
  const native = new NativeExclusiveLock(lockPath, true);
  await native.wait();
  return new ExclusiveLock(native);
}

exports.SecureRoot = SecureRoot;
exports.tryExclusiveLock = tryExclusiveLock;
exports.waitForExclusiveLock = waitForExclusiveLock;
exports.markDescriptorsCloseOnExec = markDescriptorsCloseOnExec;
exports.killWithParent = killWithParent;

exports.applyPrivateDirectorySync = applyPrivateDirectorySync;
exports.verifyPrivateDirectorySync = verifyPrivateDirectorySync;

exports.setDefaultOwnerToCurrentUserSync = setDefaultOwnerToCurrentUserSync;
