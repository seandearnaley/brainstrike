#!/usr/bin/env node
/**
 * Trace Re-render Chain Script
 *
 * Analyzes the logs to understand the version update → re-render chain.
 */

import { readFileSync } from 'fs';

const logFile = process.argv[2];
if (!logFile) {
  console.error('Usage: node trace-rerender-chain.mjs <log-file-path>');
  process.exit(1);
}

const raw = readFileSync(logFile, 'utf8');
const logs = JSON.parse(raw);

console.log(`\n=== RE-RENDER CHAIN ANALYSIS ===\n`);

// Find all version-related logs
const versionLogs = logs.filter(l =>
  l.message?.includes('version') ||
  l.serializedArgs?.toLowerCase().includes('version')
);
console.log(`Version-related logs: ${versionLogs.length}`);

// Track the sequence: Hot cache updated → anything else?
const hotCacheUpdates = logs.filter(l => l.message?.includes('Hot cache updated'));
console.log(`\n--- Timeline around first Hot cache update ---`);
if (hotCacheUpdates.length > 0) {
  const firstUpdate = hotCacheUpdates[0];
  const timestamp = firstUpdate.timestamp;

  // Find logs within 1000ms of the first hot cache update
  const nearbyLogs = logs.filter(l =>
    Math.abs(l.timestamp - timestamp) < 1000
  ).sort((a, b) => a.timestamp - b.timestamp);

  console.log(`Logs within 1s of first hot cache update (ts=${timestamp}):`);
  nearbyLogs.forEach((log, i) => {
    const delta = log.timestamp - timestamp;
    const deltaStr = delta >= 0 ? `+${delta}ms` : `${delta}ms`;
    console.log(`  ${deltaStr} [${log.scope}] ${log.message || log.args?.[0] || 'unknown'}`);
  });
}

// Check for any "getTokenCount" or similar reads
const getTokenLogs = logs.filter(l =>
  l.message?.includes('getTokenCount') ||
  l.message?.includes('token-cache diag') ||
  l.serializedArgs?.includes('getTokenCount')
);
console.log(`\n--- Token Count Read Logs ---`);
console.log(`getTokenCount/diag logs: ${getTokenLogs.length}`);
getTokenLogs.slice(0, 10).forEach((log, i) => {
  console.log(`  ${i + 1}. [${log.scope}] ${log.message}`);
});

// Check for useMemo or render-related logs
const renderLogs = logs.filter(l =>
  l.message?.includes('render') ||
  l.message?.includes('useMemo') ||
  l.message?.includes('flatListItems')
);
console.log(`\n--- Render-related logs: ${renderLogs.length} ---`);

// Analyze the cycle of effects
console.log(`\n--- Selection Effect Pattern ---`);
const selectionEffects = logs.filter(l => l.message === 'Selection effect triggered');
const timestamps = selectionEffects.map(l => l.timestamp);
const uniqueTimestamps = [...new Set(timestamps)];
console.log(`Total selection effects: ${selectionEffects.length}`);
console.log(`Unique timestamps: ${uniqueTimestamps.length}`);

// Group by timestamp to see clustering
const byTimestamp = {};
for (const ts of timestamps) {
  byTimestamp[ts] = (byTimestamp[ts] || 0) + 1;
}
const topTimestamps = Object.entries(byTimestamp)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10);
console.log(`Top 10 timestamps with most selection effects:`);
topTimestamps.forEach(([ts, count]) => {
  console.log(`  ${ts}: ${count} times`);
});

// Check if tokenCacheReady changes
console.log(`\n--- TokenCache Ready State Changes ---`);
const readyStates = selectionEffects.map(l => {
  const args = l.args || [];
  const data = args[1] || {};
  return { ts: l.timestamp, tokenCacheReady: data.tokenCacheReady, isReady: data.isReady };
});
const stateChanges = [];
let lastState = null;
for (const state of readyStates) {
  const key = `${state.tokenCacheReady}-${state.isReady}`;
  if (key !== lastState) {
    stateChanges.push(state);
    lastState = key;
  }
}
console.log(`State changes detected: ${stateChanges.length}`);
stateChanges.forEach((s, i) => {
  console.log(`  ${i + 1}. tokenCacheReady=${s.tokenCacheReady}, isReady=${s.isReady}`);
});

console.log(`\n=== END ANALYSIS ===\n`);
