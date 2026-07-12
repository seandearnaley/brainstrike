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

  readFile(relativePath, maxBytes) {
    return this.#native.readFile(relativePath, maxBytes);
  }
}

module.exports = { ['SecureRoot']: SecureRoot };
