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

/**
 * A rendered shell plus the policies the serving host must deliver as
 * RESPONSE HEADERS. The shell carries no CSP meta tag: the nested
 * `about:srcdoc` app document inherits only a header policy, and
 * `Permissions-Policy` is header-only (a meta tag would be inert).
 */
export interface McpAppSandboxShellDocument {
  readonly contentSecurityPolicy: string;
  readonly document: string;
  readonly permissionsPolicy: string;
}

export interface McpAppSandboxShellLease {
  readonly shellUrl: string;
  readonly token: string;
}

/**
 * The host that serves shells on an origin of their own (desktop: the
 * `brainstrike-mcp-app:` protocol behind `window.mcp.apps`). `releaseShell`
 * must make the URL unreachable immediately. This owner is host-agnostic: it
 * never mints URLs itself, so a shell can never land on the host origin.
 */
export interface McpAppSandboxShellHost {
  prepareShell(shell: McpAppSandboxShellDocument): Promise<McpAppSandboxShellLease>;
  releaseShell(lease: { readonly token: string }): Promise<void>;
}

interface McpAppSandboxOwnerOptions {
  readonly limits?: {
    readonly maxActiveFrames: number;
    readonly maxRetainedBytes: number;
  };
  readonly shellHost: McpAppSandboxShellHost;
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
  const fontSources = resources.length === 0 ? [] : [`font-src ${resources.join(' ')}`];
  const contentSecurityPolicy = [
    // Spec default for an omitted baseUriDomains is same-origin ('self').
    `base-uri ${sources(csp?.baseUriDomains, ["'self'"])}`,
    `connect-src ${sources(csp?.connectDomains, ["'none'"])}`,
    "default-src 'none'",
    ...fontSources,
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

/**
 * The app document is embedded as a JS string literal inside the shell's
 * inline script. Escaping only `</script` is not total: `<!--` also switches
 * the HTML tokenizer into escaped script data and swallows the rest of the
 * bootstrap, so every `<` is emitted as `\x3c` and no app byte can end or
 * alter the script element.
 */
function embedAsJavaScriptString(value: string): string {
  return JSON.stringify(value).replace(/</g, String.raw`\x3c`);
}

function cspMeta(policy: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(policy)}">`;
}

const LEADING_DOCTYPE = /^\s*<!doctype\b[^>]*>/iu;

/**
 * The host owns the doctype: emitting `<!doctype html>` first and stripping
 * the app's keeps standards mode (a meta tag before the app's doctype would
 * force quirks mode and turn that doctype into a bogus comment) while the CSP
 * still precedes every byte of app content.
 */
export function renderMcpAppResourceDocument(
  resource: McpAppOwnedResource,
  policy: McpAppSandboxPolicy
): string {
  const body = resource.html.replace(LEADING_DOCTYPE, '');
  return `<!doctype html>${cspMeta(policy.contentSecurityPolicy)}<meta name="referrer" content="no-referrer">${body}`;
}

/**
 * The shell carries the app policy VERBATIM — as a response HEADER served by
 * the host, never as a meta tag. The nested `about:srcdoc` app document
 * inherits whichever header policies bind the shell and CSP combination only
 * ever narrows, so any directive the shell omits or tightens is denied to the
 * app too: a literal shell policy would block every server-declared
 * `resourceDomains`/`connectDomains`/`frameDomains`. Chromium exempts the
 * srcdoc load itself from `frame-src` (verified against a shell with
 * `frame-src 'none'`), so the app's `frameDomains` govern its nested frames
 * through both documents. The shell's sole script is the literal bootstrap
 * below, so the widened sources have nothing in the shell to reach.
 */
export function renderMcpAppSandboxShellDocument(
  resourceDocument: string,
  policy: McpAppSandboxPolicy
): string {
  const embeddedResource = embedAsJavaScriptString(resourceDocument);
  const allow = embedAsJavaScriptString(policy.iframeAllow);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>MCP App sandbox</title><style>html,body,iframe{border:0;height:100%;margin:0;padding:0;width:100%}</style></head><body><script>(()=>{'use strict';const frame=document.createElement('iframe');frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('allow',${allow});frame.setAttribute('referrerpolicy','no-referrer');frame.title='MCP App';frame.srcdoc=${embeddedResource};document.body.append(frame)})()</script></body></html>`;
}

/** Everything a shell host needs to serve one mount: the document and its header policies. */
export function renderMcpAppSandboxShell(
  resource: McpAppOwnedResource
): McpAppSandboxShellDocument {
  const policy = buildMcpAppSandboxPolicy(resource.meta);
  const resourceDocument = renderMcpAppResourceDocument(resource, policy);
  return Object.freeze({
    contentSecurityPolicy: policy.contentSecurityPolicy,
    document: renderMcpAppSandboxShellDocument(resourceDocument, policy),
    permissionsPolicy: policy.permissionsPolicy,
  });
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
  #pendingFrames = 0;
  #retainedBytes = 0;
  readonly #shellHost: McpAppSandboxShellHost;

  constructor(options: McpAppSandboxOwnerOptions) {
    this.#shellHost = options.shellHost;
    this.#maxActiveFrames = parseLimit(
      options.limits?.maxActiveFrames ?? DEFAULT_MAX_ACTIVE_FRAMES,
      'MCP Apps active frame limit'
    );
    this.#maxRetainedBytes = parseLimit(
      options.limits?.maxRetainedBytes ?? DEFAULT_MAX_RETAINED_BYTES,
      'MCP Apps retained memory limit'
    );
  }

  /** Mounts the host has served plus registrations still in flight. */
  get activeFrames(): number {
    return this.#mounts.size + this.#pendingFrames;
  }

  get retainedBytes(): number {
    return this.#retainedBytes;
  }

  /**
   * Renders the shell, reserves its budget, then asks the host to serve it.
   * The budget is reserved BEFORE the asynchronous registration so concurrent
   * opens cannot overshoot the limits; a failed registration releases the
   * reservation and owns nothing.
   */
  async open(resource: McpAppOwnedResource): Promise<McpAppSandboxMount> {
    if (this.activeFrames >= this.#maxActiveFrames) {
      throw new TypeError('MCP Apps active frame limit exceeded');
    }
    const shell = renderMcpAppSandboxShell(resource);
    const retainedBytes = new TextEncoder().encode(shell.document).byteLength;
    if (this.#retainedBytes + retainedBytes > this.#maxRetainedBytes) {
      throw new TypeError('MCP Apps retained memory limit exceeded');
    }
    this.#pendingFrames += 1;
    this.#retainedBytes += retainedBytes;
    let lease: McpAppSandboxShellLease;
    try {
      lease = await this.#shellHost.prepareShell(shell);
    } catch (error: unknown) {
      this.#pendingFrames -= 1;
      this.#retainedBytes -= retainedBytes;
      throw error;
    }
    let closed = false;
    const mount: McpAppSandboxMount = Object.freeze({
      close: async () => {
        if (closed) {
          return;
        }
        // Ownership is released only after the host confirms the release, so
        // a failed release stays observable and retryable instead of leaking
        // a served shell.
        await this.#shellHost.releaseShell({ token: lease.token });
        closed = true;
        this.#mounts.delete(mount);
        this.#retainedBytes -= retainedBytes;
      },
      shellUrl: lease.shellUrl,
    });
    this.#pendingFrames -= 1;
    this.#mounts.add(mount);
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
