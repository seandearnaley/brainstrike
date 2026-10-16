import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const agentRequire = createRequire(path.join(root, 'packages/agent/package.json'));
const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'));
const uiRequire = createRequire(path.join(root, 'packages/ui/package.json'));
const coreRequire = createRequire(agentRequire.resolve('@mastra/core'));
const expressRequire = createRequire(coreRequire.resolve('express'));
const concurrentlyRequire = createRequire(desktopRequire.resolve('concurrently'));
const memoryRequire = createRequire(agentRequire.resolve('@mastra/memory'));
const transformersRequire = createRequire(agentRequire.resolve('@huggingface/transformers'));
const mermaidRequire = createRequire(uiRequire.resolve('mermaid'));

// GHSA-jqcg-44mw-7w3h: exercise the copy Express actually loads, including
// the valid subnet control. Presence in the graph alone proves no exposure.
test('Express cannot trust arbitrary IPv4 clients through an IPv6 subnet', () => {
  const proxyaddr = expressRequire('proxy-addr');
  const request = {
    connection: { remoteAddress: '203.0.113.5' },
    headers: { 'x-forwarded-for': '192.0.2.99' },
  };
  for (const subnet of ['::ffff:10.0.0.0/8', '::/1']) {
    const trust = proxyaddr.compile(subnet);
    assert.equal(trust('203.0.113.5'), false);
    assert.equal(proxyaddr(request, trust), '203.0.113.5');
  }
  const validTrust = proxyaddr.compile('::ffff:10.0.0.0/104');
  assert.equal(validTrust('10.1.2.3'), true);
  assert.equal(validTrust('203.0.113.5'), false);
});

// GHSA-pqg4-j6r4-53mv: no shell is executed by this regression.
test('concurrently shell quoting rejects line terminators after comment tokens', () => {
  const { quote } = concurrentlyRequire('shell-quote');
  for (const terminator of ['\n', '\r', '\u2028', '\u2029']) {
    assert.throws(() => quote(['echo', 'ok', { comment: 'x' }, `a${terminator}id;#`]), TypeError);
  }
  assert.equal(quote(['echo', 'two words']), "echo 'two words'");
});

// GHSA-p98j-92pf-mc4p: keep the detached descendant reference. Inspecting
// root.innerHTML alone would miss the armed handler on the removed subtree.
for (const hook of ['afterSanitizeElements', 'afterSanitizeAttributes']) {
  test(`Mermaid's sanitizer neutralizes descendants detached in ${hook}`, () => {
    const { JSDOM } = uiRequire('jsdom');
    const { window } = new JSDOM('<!DOCTYPE html><body></body>');
    try {
      const purify = mermaidRequire('dompurify')(window);
      const element = window.document.createElement('div');
      element.innerHTML = '<section id="wrap"><img src="x" onerror="ATTACKER()"></section>';
      window.document.body.appendChild(element);
      const image = element.querySelector('img');
      purify.addHook(hook, (node) => {
        if (node.id === 'wrap') {
          node.remove();
        }
      });
      purify.sanitize(element, { IN_PLACE: true });
      assert.equal(element.querySelector('#wrap'), null);
      assert.equal(image.hasAttribute('onerror'), false);
    } finally {
      window.close();
    }
  });
}

test('Mastra image probing preserves SVG dimensions in sync and streamed paths', async () => {
  const probe = memoryRequire('probe-image-size');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="12"></svg>');
  const sync = probe.sync(svg);
  const streamed = await probe(Readable.from([svg.subarray(0, 30), svg.subarray(30)]));
  for (const result of [sync, streamed]) {
    assert.equal(result.width, 16);
    assert.equal(result.height, 12);
    assert.equal(result.type, 'svg');
  }
});

test('Transformers loads the patched native SVG decoder and decodes an image', async () => {
  const sharp = transformersRequire('sharp');
  // GHSA-wq5f-xc86-pv6w is fixed in librsvg 2.63.2 bundled with sharp 0.35.5.
  // This is local binary provenance plus a decode smoke, not Linux RCE proof.
  const [major, minor, patch] = sharp.versions.rsvg.split('.').map(Number);
  assert.ok(major > 2 || (major === 2 && (minor > 63 || (minor === 63 && patch >= 2))));
  const { info } = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"><rect width="3" height="2" fill="red"/></svg>'
    )
  )
    .png()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 3);
  assert.equal(info.height, 2);
});
