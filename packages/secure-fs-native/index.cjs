'use strict';

const bindings = require('bindings');

const { SecureRoot: NativeSecureRoot, tryExclusiveFlock } = bindings({
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

exports.SecureRoot = SecureRoot;
exports.tryExclusiveFlock = tryExclusiveFlock;
