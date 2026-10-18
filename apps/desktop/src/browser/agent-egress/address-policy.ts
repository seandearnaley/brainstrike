/**
 * Which connection targets agent browsing may reach (BST-1238). The egress
 * proxy asks this about every address it is about to dial, after its own DNS
 * resolution, so the answer covers the address actually connected to, not a
 * URL's text.
 *
 * Node's `net.BlockList` is the matcher. It checks `::ffff:`-mapped IPv6
 * against IPv4 subnets natively, but not the other IPv4 carriers, so NAT64's
 * embedded IPv4 is extracted and checked, and the deprecated carriers are
 * refused outright.
 */
import { BlockList, isIPv4, isIPv6 } from 'node:net';

export type RefusedAddressClass =
  | 'loopback'
  | 'private'
  | 'shared'
  | 'link-local'
  | 'multicast'
  | 'unspecified'
  | 'reserved'
  | 'documentation'
  | 'benchmarking'
  | 'ipv4-carrier'
  | 'not-global-unicast'
  | 'invalid';

type Ranges = ReadonlyArray<readonly [address: string, prefix: number]>;

// IANA IPv4 special-purpose registry, plus multicast and the reserved class E.
const IPV4: ReadonlyArray<readonly [RefusedAddressClass, Ranges]> = [
  ['unspecified', [['0.0.0.0', 8]]],
  ['loopback', [['127.0.0.0', 8]]],
  [
    'private',
    [
      ['10.0.0.0', 8],
      ['172.16.0.0', 12],
      ['192.168.0.0', 16],
    ],
  ],
  // CGNAT; also Alibaba Cloud's metadata service (100.100.100.200).
  ['shared', [['100.64.0.0', 10]]],
  // Includes the cloud metadata address 169.254.169.254.
  ['link-local', [['169.254.0.0', 16]]],
  ['multicast', [['224.0.0.0', 4]]],
  [
    'reserved',
    [
      // IETF protocol assignments; includes Oracle Cloud's metadata 192.0.0.192.
      ['192.0.0.0', 24],
      ['192.88.99.0', 24],
      // Class E and the limited broadcast address.
      ['240.0.0.0', 4],
    ],
  ],
  [
    'documentation',
    [
      ['192.0.2.0', 24],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
    ],
  ],
  ['benchmarking', [['198.18.0.0', 15]]],
];

// Checked in order, before the global-unicast rule: the named classes give a
// refusal its reason.
const IPV6: ReadonlyArray<readonly [RefusedAddressClass, Ranges]> = [
  ['unspecified', [['::', 128]]],
  ['loopback', [['::1', 128]]],
  [
    'ipv4-carrier',
    [
      // IPv4-compatible (deprecated), 6to4 and Teredo.
      ['::', 96],
      ['2002::', 16],
      ['2001::', 32],
      // Local-use NAT64 translates into a network that is not the internet's.
      ['64:ff9b:1::', 48],
    ],
  ],
  [
    'private',
    [
      ['fc00::', 7],
      // Site-local (deprecated).
      ['fec0::', 10],
    ],
  ],
  ['link-local', [['fe80::', 10]]],
  ['multicast', [['ff00::', 8]]],
  ['documentation', [['2001:db8::', 32]]],
  ['benchmarking', [['2001:2::', 48]]],
  [
    'reserved',
    [
      ['100::', 64],
      // ORCHID and ORCHIDv2: identifiers, never routable.
      ['2001:10::', 28],
      ['2001:20::', 28],
    ],
  ],
];

function blockLists(
  table: ReadonlyArray<readonly [RefusedAddressClass, Ranges]>,
  family: 'ipv4' | 'ipv6'
): ReadonlyArray<readonly [RefusedAddressClass, BlockList]> {
  return table.map(([addressClass, ranges]) => {
    const list = new BlockList();
    for (const [address, prefix] of ranges) {
      list.addSubnet(address, prefix, family);
    }
    return [addressClass, list] as const;
  });
}

const IPV4_LISTS = blockLists(IPV4, 'ipv4');
const IPV6_LISTS = blockLists(IPV6, 'ipv6');
const GLOBAL_UNICAST = new BlockList();
GLOBAL_UNICAST.addSubnet('2000::', 3, 'ipv6');
const IPV4_MAPPED = new BlockList();
IPV4_MAPPED.addSubnet('::ffff:0:0', 96, 'ipv6');
const NAT64 = new BlockList();
NAT64.addSubnet('64:ff9b::', 96, 'ipv6');

/** The 16 bytes of an IPv6 address, or null when it does not parse. */
function ipv6Bytes(address: string): Uint8Array | null {
  let text = address;
  const tail: number[] = [];
  const dotted = text.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted?.[1] && dotted[2]) {
    if (!isIPv4(dotted[2])) {
      return null;
    }
    const [a, b, c, d] = dotted[2].split('.').map(Number) as [number, number, number, number];
    tail.push((a << 8) | b, (c << 8) | d);
    text = dotted[1].endsWith('::') ? dotted[1] : dotted[1].slice(0, -1);
  }
  const halves = text.split('::');
  if (halves.length > 2) {
    return null;
  }
  const parse = (part: string | undefined): number[] =>
    part === undefined || part === ''
      ? []
      : part.split(':').map((group) => Number.parseInt(group, 16));
  const head = parse(halves[0]);
  const rest = [...parse(halves[1]), ...tail];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) {
    return null;
  }
  const groups = [...head, ...new Array<number>(missing).fill(0), ...rest];
  if (groups.some((group) => !(Number.isInteger(group) && group >= 0 && group <= 0xff_ff))) {
    return null;
  }
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

function embeddedIpv4(address: string): string | null {
  const bytes = ipv6Bytes(address);
  return bytes ? `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}` : null;
}

function classifyIpv4(address: string): RefusedAddressClass | null {
  for (const [addressClass, list] of IPV4_LISTS) {
    if (list.check(address, 'ipv4')) {
      return addressClass;
    }
  }
  return null;
}

/**
 * Why agent browsing may not connect to `address`, or null when it may. The
 * address must be an IP literal (a resolved answer); anything else is refused
 * as `invalid`, so a caller that forgets to resolve fails closed.
 */
export function refusedAddressClass(address: string): RefusedAddressClass | null {
  const unbracketed = address.replace(/^\[(.*)\]$/, '$1');
  if (isIPv4(unbracketed)) {
    return classifyIpv4(unbracketed);
  }
  if (!isIPv6(unbracketed)) {
    return 'invalid';
  }
  // Zone indexes (fe80::1%eth0) only qualify link-local addresses.
  const ipv6 = unbracketed.split('%')[0] ?? unbracketed;
  if (IPV4_MAPPED.check(ipv6, 'ipv6') || NAT64.check(ipv6, 'ipv6')) {
    const ipv4 = embeddedIpv4(ipv6);
    return ipv4 === null ? 'invalid' : classifyIpv4(ipv4);
  }
  for (const [addressClass, list] of IPV6_LISTS) {
    if (list.check(ipv6, 'ipv6')) {
      return addressClass;
    }
  }
  return GLOBAL_UNICAST.check(ipv6, 'ipv6') ? null : 'not-global-unicast';
}
