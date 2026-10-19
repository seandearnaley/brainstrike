import { describe, expect, test } from 'vitest';
import { refusedAddressClass } from '../agent-egress/address-policy';

describe('agent egress address policy (BST-1238)', () => {
  test.each([
    ['8.8.8.8'],
    ['1.1.1.1'],
    ['93.184.216.34'],
    ['172.15.255.255'],
    ['172.32.0.0'],
    ['100.63.255.255'],
    ['2606:4700:4700::1111'],
    ['[2606:4700:4700::1111]'],
    // A public IPv4 in every carrier the policy sees through.
    ['::ffff:8.8.8.8'],
    ['::ffff:808:808'],
    ['64:ff9b::808:808'],
    ['64:ff9b::8.8.8.8'],
  ])('admits the public address %s', (address) => {
    expect(refusedAddressClass(address)).toBeNull();
  });

  test.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['0.0.0.0', 'unspecified'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'shared'],
    ['100.100.100.200', 'shared'],
    ['169.254.169.254', 'link-local'],
    ['224.0.0.251', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['192.0.0.192', 'reserved'],
    ['255.255.255.255', 'reserved'],
    ['240.0.0.1', 'reserved'],
    ['192.0.2.1', 'documentation'],
    ['198.51.100.7', 'documentation'],
    ['203.0.113.9', 'documentation'],
    ['198.18.0.1', 'benchmarking'],
    ['::1', 'loopback'],
    ['[::1]', 'loopback'],
    ['0:0:0:0:0:0:0:1', 'loopback'],
    ['::', 'unspecified'],
    ['fc00::1', 'private'],
    ['fd00:ec2::254', 'private'],
    ['fec0::1', 'private'],
    ['fe80::1', 'link-local'],
    ['fe80::1%eth0', 'link-local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['2001:2::1', 'benchmarking'],
    ['100::1', 'reserved'],
    ['2001:10::1', 'reserved'],
    // A private IPv4 inside each carrier, in hex and dotted spellings.
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:a9fe:a9fe', 'link-local'],
    ['0:0:0:0:0:ffff:c0a8:101', 'private'],
    ['64:ff9b::7f00:1', 'loopback'],
    ['64:ff9b::169.254.169.254', 'link-local'],
    // Carriers the policy does not see through are refused outright.
    ['::7f00:1', 'ipv4-carrier'],
    ['::8.8.8.8', 'ipv4-carrier'],
    ['2002:7f00:1::', 'ipv4-carrier'],
    ['2002:808:808::', 'ipv4-carrier'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'ipv4-carrier'],
    ['64:ff9b:1::808:808', 'ipv4-carrier'],
    // Outside 2000::/3 and not otherwise named.
    ['4000::1', 'not-global-unicast'],
    ['e000::1', 'not-global-unicast'],
  ])('refuses %s as %s', (address, addressClass) => {
    expect(refusedAddressClass(address)).toBe(addressClass);
  });

  test.each([
    ['localhost'],
    ['example.com'],
    [''],
    ['127.1'],
    ['0x7f000001'],
    ['2130706433'],
    ['::ffff:999.0.0.1'],
    ['1::2::3'],
  ])('fails closed on %j, which is not an IP literal', (address) => {
    expect(refusedAddressClass(address)).toBe('invalid');
  });
});
