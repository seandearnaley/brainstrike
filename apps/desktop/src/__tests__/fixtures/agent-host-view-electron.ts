import { readFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { decodeHostRecord } from '@brainstrike/host-lease';
import { app, BrowserWindow, MessageChannelMain } from 'electron';
import { type Message, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';

const root = process.env['BRAINSTRIKE_M3_OWNED_ROOT'];
const html = process.env['BRAINSTRIKE_M3_OWNED_HTML'];
const preload = process.env['BRAINSTRIKE_M3_OWNED_PRELOAD'];
const threadId = process.env['BRAINSTRIKE_M3_OWNED_THREAD'];
if (!(root && html && preload && threadId)) {
  throw new Error('Owned M3 view fixture requires root, HTML, preload and thread');
}
app.setPath('userData', join(root, 'owned-electron-view'));
app
  .whenReady()
  .then(async () => {
    const record = decodeHostRecord(JSON.parse(await readFile(join(root, 'host.json'), 'utf8')));
    const socket = new Socket();
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
      socket.connect(record.endpoint);
    });
    const channel = new MessageChannelMain();
    const reader = new StreamMessageReader(socket);
    const writer = new StreamMessageWriter(socket);
    // Electron uses {data,ports}; the vendor stream reader/writer owns JSON-RPC framing.
    // This is a transport bridge only: the real host authenticates and dispatches every request.
    const receive = (event: { data: unknown }): void => {
      writer.write(event.data as Message).catch(() => socket.destroy());
    };
    channel.port1.on('message', receive);
    const listening = reader.listen((message) => channel.port1.postMessage(message));
    channel.port1.start();
    const window = new BrowserWindow({
      height: 720,
      show: true,
      webPreferences: { contextIsolation: true, preload, sandbox: true },
      width: 960,
    });
    socket.on('error', () => socket.destroy());
    socket.once('close', () => {
      channel.port1.close();
      reader.dispose();
      writer.dispose();
    });
    channel.port1.once('close', () => socket.destroy());
    window.once('closed', () => {
      channel.port1.off('message', receive);
      listening.dispose();
      socket.destroy();
    });
    await window.loadFile(html, { query: { threadId } });
    window.webContents.postMessage('agent-host/connect', record, [channel.port2]);
  })
  .catch((cause: unknown) => {
    process.stderr.write(`${String(cause)}\n`);
    app.exit(1);
  });
app.on('window-all-closed', () => app.quit());
