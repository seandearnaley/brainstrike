/**
 * The local guard webExtract applies to each model-supplied URL before it is
 * sent to the external extraction service. A leaf module: the browser pane's
 * runner in Main shares it without loading any tool.
 */

/** RFC1918/loopback/link-local/unspecified IPv4, from a dotted-quad literal. */
function isPrivateIpv4(dottedQuad: string): boolean {
  const octets = dottedQuad.split('.');
  if (!(octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part)))) {
    return false;
  }
  const [a, b] = octets.map(Number) as [number, number, number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/**
 * Extract the embedded IPv4 address from an IPv4-mapped (`::ffff:a.b.c.d`,
 * within ::ffff:0:0/96) or deprecated IPv4-compatible (`::a.b.c.d`, within
 * ::/96) IPv6 literal. The WHATWG URL parser serializes BOTH to hex hextets
 * (`::ffff:7f00:1` / `::7f00:1` — verified against Node), so match the hex
 * forms; dotted forms are kept as defense in depth for non-URL callers.
 */
function ipv4EmbeddedInIpv6(host: string): string | null {
  const dotted = host.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted?.[1]) {
    return dotted[1];
  }
  const hex = host.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex?.[1] && hex[2]) {
    const hi = Number.parseInt(hex[1], 16);
    const lo = Number.parseInt(hex[2], 16);
    return `${Math.floor(hi / 256)}.${hi % 256}.${Math.floor(lo / 256)}.${lo % 256}`;
  }
  return null;
}

/** RFC1918/loopback/link-local IPv4 (incl. IPv4-mapped/compat IPv6 carriers) +
 * unique-local/link-local/loopback IPv6 + localhost names. */
function isPrivateOrLoopbackHost(hostname: string): boolean {
  // Lowercase, unbracket IPv6, and strip a single root-label trailing dot
  // ("localhost." resolves identically to "localhost").
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  // IPv6 literals: loopback, unspecified, link-local fe80::/10, unique-local
  // fc00::/7, and IPv4-mapped/compat carriers of a private IPv4.
  if (host.includes(':')) {
    if (host === '::1' || host === '::' || /^fe[89ab]/.test(host) || /^f[cd]/.test(host)) {
      return true;
    }
    const embeddedIpv4 = ipv4EmbeddedInIpv6(host);
    return embeddedIpv4 !== null && isPrivateIpv4(embeddedIpv4);
  }
  // IPv4 literals only — public HOSTNAMES are not DNS-resolved here (the fetch
  // happens on Tavily's servers, not this machine; the guard's job is to keep
  // clearly-internal URLs from ever being SENT to the external service).
  // Obfuscated decimal/octal/hex IPv4 forms are already normalized to
  // dotted-quad by the WHATWG URL parser before this check runs.
  return isPrivateIpv4(host);
}

/**
 * Validate one model-supplied URL BEFORE it is sent to the external service:
 * parseable, http/https only, no embedded credentials, no private/loopback/
 * link-local hosts. Returns the refusal reason, or null when acceptable.
 */
export function refuseExtractUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return 'invalid URL — must be an absolute http(s) URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `refused: protocol "${parsed.protocol}" is not allowed (http/https only)`;
  }
  if (parsed.username || parsed.password) {
    return 'refused: URLs with embedded credentials are never sent to the extraction service';
  }
  if (isPrivateOrLoopbackHost(parsed.hostname)) {
    return 'refused: private/loopback/link-local hosts are never sent to the extraction service';
  }
  return null;
}
