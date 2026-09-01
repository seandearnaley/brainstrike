import type { McpAppResourceMeta, McpAppResourcePermissions } from './metadata.js';
import type { McpAppOwnedResource } from './provenance.js';

const DEFAULT_MAX_ACTIVE_FRAMES = 8;
const DEFAULT_MAX_RETAINED_BYTES = 4 * 1024 * 1024;
const DENIED_PERMISSIONS = ['camera', 'clipboard-write', 'geolocation', 'microphone'] as const;

export interface McpAppSandboxPolicy {
  readonly contentSecurityPolicy: string;
  readonly iframeAllow: string;
  readonly permissionsPolicy: string;
  readonly requestedPermissions: readonly string[];
  readonly sandbox: 'allow-scripts';
}

export interface McpAppSandboxMount {
  readonly close: () => Promise<void>;
  readonly shellUrl: string;
}

export interface McpAppSandboxUrlApi {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

interface McpAppSandboxOwnerOptions {
  readonly limits?: {
    readonly maxActiveFrames: number;
    readonly maxRetainedBytes: number;
  };
  readonly urls: McpAppSandboxUrlApi;
}

function sources(values: readonly string[] | undefined, fallbacks: readonly string[]): string {
  return values === undefined || values.length === 0 ? fallbacks.join(' ') : values.join(' ');
}

function requestedPermissions(
  permissions: McpAppResourcePermissions | undefined
): readonly string[] {
  if (permissions === undefined) {
    return Object.freeze([]);
  }
  return Object.freeze(
    [
      permissions.camera === undefined ? undefined : 'camera',
      permissions.clipboardWrite === undefined ? undefined : 'clipboard-write',
      permissions.geolocation === undefined ? undefined : 'geolocation',
      permissions.microphone === undefined ? undefined : 'microphone',
    ].filter((permission): permission is string => permission !== undefined)
  );
}

export function buildMcpAppSandboxPolicy(
  meta: McpAppResourceMeta | undefined
): McpAppSandboxPolicy {
  const csp = meta?.csp;
  const resources = csp?.resourceDomains ?? [];
  const resourceSources = resources.length === 0 ? '' : ` ${resources.join(' ')}`;
  const contentSecurityPolicy = [
    `base-uri ${sources(csp?.baseUriDomains, ["'none'"])}`,
    `connect-src ${sources(csp?.connectDomains, ["'none'"])}`,
    "default-src 'none'",
    `font-src data:${resourceSources}`,
    "form-action 'none'",
    `frame-src ${sources(csp?.frameDomains, ["'none'"])}`,
    `img-src data:${resourceSources}`,
    `media-src data:${resourceSources}`,
    "object-src 'none'",
    `script-src 'unsafe-inline'${resourceSources}`,
    `style-src 'unsafe-inline'${resourceSources}`,
    "worker-src 'none'",
  ].join('; ');
  return Object.freeze({
    contentSecurityPolicy,
    iframeAllow: DENIED_PERMISSIONS.map((permission) => `${permission} 'none'`).join('; '),
    permissionsPolicy: DENIED_PERMISSIONS.map((permission) => `${permission}=()`).join(', '),
    requestedPermissions: requestedPermissions(meta?.permissions),
    sandbox: 'allow-scripts',
  });
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function embedAsJavaScriptString(value: string): string {
  return JSON.stringify(value).replace(/<\//g, String.raw`<\/`);
}

function cspMeta(policy: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(policy)}">`;
}

export function renderMcpAppResourceDocument(
  resource: McpAppOwnedResource,
  policy: McpAppSandboxPolicy
): string {
  return `${cspMeta(policy.contentSecurityPolicy)}<meta name="referrer" content="no-referrer">${resource.html}`;
}

export function renderMcpAppSandboxShellDocument(
  resourceDocument: string,
  policy: McpAppSandboxPolicy
): string {
  const shellCsp = policy.contentSecurityPolicy.replace(/frame-src [^;]+/, "frame-src 'self'");
  const embeddedResource = embedAsJavaScriptString(resourceDocument);
  const allow = embedAsJavaScriptString(policy.iframeAllow);
  return `<!doctype html><html><head><meta charset="utf-8">${cspMeta(shellCsp)}<meta http-equiv="Permissions-Policy" content="${escapeHtmlAttribute(policy.permissionsPolicy)}"><meta name="referrer" content="no-referrer"><title>MCP App sandbox</title><style>html,body,iframe{border:0;height:100%;margin:0;padding:0;width:100%}</style></head><body><script>(()=>{'use strict';const frame=document.createElement('iframe');frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('allow',${allow});frame.setAttribute('referrerpolicy','no-referrer');frame.title='MCP App';frame.srcdoc=${embeddedResource};document.body.append(frame)})()</script></body></html>`;
}

function parseLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

export class McpAppSandboxOwner {
  readonly #maxActiveFrames: number;
  readonly #maxRetainedBytes: number;
  readonly #mounts = new Set<McpAppSandboxMount>();
  #retainedBytes = 0;
  readonly #urls: McpAppSandboxUrlApi;

  constructor(options: McpAppSandboxOwnerOptions) {
    this.#urls = options.urls;
    this.#maxActiveFrames = parseLimit(
      options.limits?.maxActiveFrames ?? DEFAULT_MAX_ACTIVE_FRAMES,
      'MCP Apps active frame limit'
    );
    this.#maxRetainedBytes = parseLimit(
      options.limits?.maxRetainedBytes ?? DEFAULT_MAX_RETAINED_BYTES,
      'MCP Apps retained memory limit'
    );
  }

  get activeFrames(): number {
    return this.#mounts.size;
  }

  get retainedBytes(): number {
    return this.#retainedBytes;
  }

  open(resource: McpAppOwnedResource): McpAppSandboxMount {
    if (this.#mounts.size >= this.#maxActiveFrames) {
      throw new TypeError('MCP Apps active frame limit exceeded');
    }
    const policy = buildMcpAppSandboxPolicy(resource.meta);
    const resourceDocument = renderMcpAppResourceDocument(resource, policy);
    const shellDocument = renderMcpAppSandboxShellDocument(resourceDocument, policy);
    const retainedBytes = new TextEncoder().encode(shellDocument).byteLength;
    if (this.#retainedBytes + retainedBytes > this.#maxRetainedBytes) {
      throw new TypeError('MCP Apps retained memory limit exceeded');
    }
    const shellUrl = this.#urls.createObjectURL(
      new Blob([shellDocument], { type: 'text/html;charset=utf-8' })
    );
    let closed = false;
    const mount: McpAppSandboxMount = Object.freeze({
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        this.#mounts.delete(mount);
        this.#retainedBytes -= retainedBytes;
        this.#urls.revokeObjectURL(shellUrl);
      },
      shellUrl,
    });
    this.#mounts.add(mount);
    this.#retainedBytes += retainedBytes;
    return mount;
  }

  async closeAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const mount of [...this.#mounts]) {
      try {
        await mount.close();
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'MCP Apps sandbox teardown failed');
    }
  }
}
