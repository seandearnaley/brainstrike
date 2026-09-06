import { createHash } from 'node:crypto';

/**
 * Executable, bounded derived profile of the pinned official MCP Apps example
 * server (`@modelcontextprotocol/ext-apps` tag v1.7.5,
 * `examples/basic-server-vanillajs`). The npm package ships only `dist`, so
 * the behaviour-defining data of the example is vendored here byte-for-byte
 * where it is data (the served document) and by exact value where it is
 * registration metadata. `registerAppTool` at this tag writes BOTH
 * `_meta.ui.resourceUri` and the flat `_meta["ui/resourceUri"]` key, so the
 * profile pins both. The lab-owned reference server consumes this object
 * directly, so its digest is the digest of the behaviour-defining data.
 */
export const APPS_PROFILE = Object.freeze({
  document:
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <meta name="color-scheme" content="light dark">\n  <title>Get Time App</title>\n</head>\n<body>\n  <main class="main">\n    <p class="notice">Watch activity in the DevTools console!</p>\n\n    <div class="action">\n      <p><strong>Server Time:</strong> <code id="server-time">Loading...</code></p>\n      <button id="get-time-btn">Get Server Time</button>\n    </div>\n\n    <div class="action">\n      <textarea id="message-text">This is message text.</textarea>\n      <button id="send-message-btn">Send Message</button>\n    </div>\n\n    <div class="action">\n      <input type="text" id="log-text" value="This is log text.">\n      <button id="send-log-btn">Send Log</button>\n    </div>\n\n    <div class="action">\n      <input type="url" id="link-url" value="https://modelcontextprotocol.io/">\n      <button id="open-link-btn">Open Link</button>\n    </div>\n  </main>\n  <script type="module" src="/src/mcp-app.ts"></script>\n</body>\n</html>\n',
  extensionId: 'io.modelcontextprotocol/ui',
  /** What an MCP Apps host must advertise in its client capabilities. */
  host: Object.freeze({ mimeTypes: Object.freeze(['text/html;profile=mcp-app']) }),
  missingResourceUri: 'ui://get-time/missing.html',
  resource: Object.freeze({
    mimeType: 'text/html;profile=mcp-app',
    name: 'ui://get-time/mcp-app.html',
    uri: 'ui://get-time/mcp-app.html',
  }),
  server: Object.freeze({ name: 'Basic MCP App Server (Vanilla JS)', version: '1.0.0' }),
  tool: Object.freeze({
    description: 'Returns the current server time as an ISO 8601 string.',
    meta: Object.freeze({
      ui: Object.freeze({ resourceUri: 'ui://get-time/mcp-app.html' }),
      'ui/resourceUri': 'ui://get-time/mcp-app.html',
    }),
    name: 'get-time',
    outputKey: 'time',
    title: 'Get Time',
  }),
  upstream: Object.freeze({
    directory: 'examples/basic-server-vanillajs',
    files: Object.freeze({
      'main.ts': 'ffbf7859535d66c1db3f6aec979afa01bd7d13e1a7f2623b7801c3bf7c4df422',
      'mcp-app.html': '5f69cc9a85ab0fe4134bccfc86062760c2a9d6a31e1c200d1be88c82e0bce4c3',
      'server.ts': '6fb0ea689385cfb870563d5cfb06218712c62f74664278ca12b1905aa6169d8d',
    }),
    /** The helper that performs the dual resource-URI metadata write. */
    helper: Object.freeze({
      path: 'src/server/index.ts',
      sha256: 'c2061cafac0aa41271ef8a3bb5e1b65a9bd4fea9074dab8536c79057bab52480',
    }),
  }),
} as const);

export const APPS_PROFILE_SHA256 = createHash('sha256')
  .update(JSON.stringify(APPS_PROFILE))
  .digest('hex');
