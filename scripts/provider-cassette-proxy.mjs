#!/usr/bin/env node
// Records model-provider traffic from any client (the dev app on a disposable
// profile, a standalone host) as one sanitized provider cassette. Point the
// client's base-URL knobs at the printed URLs; each request goes to its real
// provider with the client's own credentials, and nothing here reads one.
// Ctrl-C ends the recording: once every exchange has finished, the cassette is
// written only if no secret-looking string or local path remains in it.
//
//   node scripts/provider-cassette-proxy.mjs --out <file.json> [--scenario <name>]
//     [--substitute <literal>=<placeholder>]... [--upstream <KNOB>=<base url>]...
//
// See docs/agents/provider-cassettes.md.
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import {
  assembleProviderCassette,
  describeProviderRequestKey,
  encodeProviderCassette,
  PROVIDER_CASSETTE_UPSTREAMS,
  providerCassetteFindings,
  startProviderCassetteRecorder,
} from '../packages/test-utils/src/provider-cassette.ts';
import { scanText } from './secret-scan.mjs';

function pairs(values, flag) {
  return (values ?? []).map((value) => {
    const separator = value.indexOf('=');
    if (separator < 1) {
      throw new Error(`${flag} takes <name>=<value>, not ${value}`);
    }
    return [value.slice(0, separator), value.slice(separator + 1)];
  });
}

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    scenario: { type: 'string' },
    substitute: { multiple: true, type: 'string' },
    upstream: { multiple: true, type: 'string' },
  },
});
if (!values.out) {
  console.error('--out <file.json> is required.');
  process.exit(2);
}
const upstreams = { ...PROVIDER_CASSETTE_UPSTREAMS };
for (const [knob, url] of pairs(values.upstream, '--upstream')) {
  if (!(knob in upstreams)) {
    throw new Error(`--upstream names an unknown knob: ${knob}`);
  }
  upstreams[knob] = url;
}
const substitutions = [
  ...pairs(values.substitute, '--substitute').map(([from, to]) => ({ from, to })),
  { from: homedir(), to: '~' },
];
const scenario = values.scenario ?? basename(values.out, '.json');
const recorder = await startProviderCassetteRecorder({ substitutions, upstreams });
for (const knob of Object.keys(PROVIDER_CASSETTE_UPSTREAMS)) {
  console.log(`${knob}=${recorder.baseUrlFor(knob)}`);
}
console.log('Recording. Ctrl-C writes the cassette once every exchange has finished.');

let ending = false;
async function finish() {
  if (ending) {
    console.error('Second interrupt: nothing written.');
    process.exit(130);
  }
  ending = true;
  while (recorder.recording.inFlight() > 0) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await recorder.close();
  const cassette = assembleProviderCassette({
    exchanges: recorder.recording.exchanges(),
    recordedAt: new Date().toISOString(),
    scenario,
  });
  if (cassette.exchanges.length === 0) {
    console.error('Nothing was recorded; no cassette written.');
    process.exit(1);
  }
  const findings = [
    ...providerCassetteFindings(cassette, [
      { bounded: true, rule: 'home-directory', value: homedir() },
    ]),
    ...scanText({ filePath: values.out, text: encodeProviderCassette(cassette) }).map(
      ({ line, ruleId }) => ({ exchange: null, part: `line ${line}`, rule: ruleId })
    ),
  ];
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(
        `${finding.rule} in ${finding.part}${finding.exchange === null ? '' : ` of exchange ${finding.exchange}`}`
      );
    }
    console.error('The recording holds secret-looking or local strings; no cassette written.');
    process.exit(1);
  }
  await writeFile(values.out, encodeProviderCassette(cassette));
  for (const exchange of cassette.exchanges) {
    console.log(`${exchange.response.status} ${describeProviderRequestKey(exchange.key)}`);
  }
  console.log(`Wrote ${cassette.exchanges.length} exchanges to ${values.out}.`);
  process.exit(0);
}
process.on('SIGINT', finish);
process.on('SIGTERM', finish);
