const CALLBACK_PATH = '/mcp/oauth/callback';
const LOOPBACK_HOST = '127.0.0.1';
const AUTHORIZATION_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type AuthorizationFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function singleParameter(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name);
  return values.length === 1 && values[0] !== '' ? values[0] : undefined;
}

function isSafeLoopbackUrl(url: URL): boolean {
  return url.protocol === 'http:' && url.username === '' && url.password === '' && url.hash === '';
}

function isAuthorizationLoopback(url: URL): boolean {
  return isSafeLoopbackUrl(url) && (url.hostname === LOOPBACK_HOST || url.hostname === 'localhost');
}

function isStrictCallback(url: URL): boolean {
  return isSafeLoopbackUrl(url) && url.hostname === LOOPBACK_HOST;
}

function parseAuthorizationRequest(raw: string): {
  authorization: URL;
  callback: URL;
  state: string;
} {
  let authorization: URL;
  let callback: URL;
  try {
    authorization = new URL(raw);
    const redirectUri = singleParameter(authorization, 'redirect_uri');
    if (redirectUri === undefined) {
      throw new Error('Official MCP conformance authorization request is invalid');
    }
    callback = new URL(redirectUri);
  } catch {
    throw new Error('Official MCP conformance authorization request is invalid');
  }
  const state = singleParameter(authorization, 'state');
  if (
    !(isAuthorizationLoopback(authorization) && isStrictCallback(callback)) ||
    callback.pathname !== CALLBACK_PATH ||
    callback.search !== '' ||
    state === undefined
  ) {
    throw new Error('Official MCP conformance authorization request is invalid');
  }
  return { authorization, callback, state };
}

function parseCallback(location: string | null, expected: URL, state: string): URL {
  if (location === null) {
    throw new Error('Official MCP conformance authorization response is invalid');
  }
  let callback: URL;
  try {
    callback = new URL(location);
  } catch {
    throw new Error('Official MCP conformance authorization response is invalid');
  }
  if (
    !isStrictCallback(callback) ||
    callback.origin !== expected.origin ||
    callback.pathname !== expected.pathname ||
    singleParameter(callback, 'code') === undefined ||
    singleParameter(callback, 'state') !== state
  ) {
    throw new Error('Official MCP conformance authorization response is invalid');
  }
  return callback;
}

export function createOfficialConformanceAuthorizationOpener(
  fetchFn: AuthorizationFetch = fetch
): (authorizationUrl: string) => Promise<void> {
  const consumedStates = new Set<string>();
  return async (authorizationUrl) => {
    const request = parseAuthorizationRequest(authorizationUrl);
    if (consumedStates.has(request.state)) {
      throw new Error('Official MCP conformance authorization request is invalid');
    }
    consumedStates.add(request.state);
    let authorizationResponse: Response;
    try {
      authorizationResponse = await fetchFn(request.authorization, { redirect: 'manual' });
    } catch {
      throw new Error('Official MCP conformance authorization request failed');
    }
    if (!AUTHORIZATION_REDIRECT_STATUSES.has(authorizationResponse.status)) {
      throw new Error('Official MCP conformance authorization response is invalid');
    }
    const callback = parseCallback(
      authorizationResponse.headers.get('location'),
      request.callback,
      request.state
    );
    let callbackResponse: Response;
    try {
      callbackResponse = await fetchFn(callback, { redirect: 'manual' });
    } catch {
      throw new Error('Official MCP conformance callback request failed');
    }
    if (!callbackResponse.ok) {
      throw new Error('Official MCP conformance callback response is invalid');
    }
  };
}
