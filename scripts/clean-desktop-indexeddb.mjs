#!/usr/bin/env node
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const appName = '@brainstrike/desktop';

const userDataPath =
  process.platform === 'darwin'
    ? path.join(homedir(), 'Library', 'Application Support', appName)
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), appName)
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), appName);

rmSync(path.join(userDataPath, 'IndexedDB'), { recursive: true, force: true });
