import { expect, test } from 'vitest';
import { windowsPrivateAcl } from '../src/windows-acl.js';

const sid = 'S-1-5-21-100-200-300-1001';
const valid = {
  currentSid: sid,
  ownerSid: sid,
  protected: true,
  rules: [
    { inheritance: 3, isInherited: false, propagation: 0, rights: 2_032_127, sid, type: 'Allow' },
  ],
};

test('Windows privacy refuses inherited, foreign, broad, malformed or truncated ACL results', async () => {
  for (const result of [
    { ...valid, protected: false },
    { ...valid, ownerSid: 'S-1-5-18' },
    { ...valid, rules: [...valid.rules, { ...valid.rules[0], sid: 'S-1-1-0' }] },
    { ...valid, rules: [{ ...valid.rules[0], isInherited: true }] },
    { ...valid, rules: [{ ...valid.rules[0], rights: 1_179_785 }] },
    { ...valid, rules: [{ ...valid.rules[0], type: 'Deny' }] },
    { ...valid, rules: [{ ...valid.rules[0], propagation: 1 }] },
    { ...valid, rules: [] },
    { ...valid, unexpected: true },
  ]) {
    await expect(
      windowsPrivateAcl('C:\\private', 'directory', 'verify', async () => JSON.stringify(result))
    ).rejects.toThrow();
  }
  await expect(
    windowsPrivateAcl('C:\\private', 'file', 'verify', async () => '{')
  ).rejects.toThrow();
});

test('Windows file ACL requires a private explicit non-inheritable user grant', async () => {
  const file = { ...valid, rules: [{ ...valid.rules[0], inheritance: 0 }] };
  await windowsPrivateAcl('C:\\private\\host.json', 'file', 'verify', async () =>
    JSON.stringify(file)
  );
  await expect(
    windowsPrivateAcl('C:\\private\\host.json', 'file', 'verify', async () => JSON.stringify(valid))
  ).rejects.toThrow();
});

test('Windows privacy passes literal paths through environment and preserves OS command failures', async () => {
  const path = 'C:\\User folder\\$();host.json';
  let environment: NodeJS.ProcessEnv | undefined;
  await windowsPrivateAcl(path, 'directory', 'set', async (env) => {
    environment = env;
    return JSON.stringify(valid);
  });
  expect(environment?.['BRAINSTRIKE_LEASE_ACL_PATH']).toBe(path);
  const cause = new Error('Windows ACL access denied');
  await expect(
    windowsPrivateAcl(path, 'directory', 'set', async () => {
      throw cause;
    })
  ).rejects.toBe(cause);
});
