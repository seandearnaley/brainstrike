'use strict';

const bindings = require('bindings');
const { realpathSync } = require('node:fs');

const { SecureRoot: NativeSecureRoot } = bindings({
  bindings: 'secure_fs_native',
  ['module_root']: __dirname,
});

class SecureRoot {
  #native;

  constructor(rootPath) {
    this.#native = new NativeSecureRoot(realpathSync.native(rootPath));
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
}

exports.SecureRoot = SecureRoot;
