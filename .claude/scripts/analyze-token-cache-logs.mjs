#!/usr/bin/env node
/**
 * Token Cache Log Analysis Script
 *
 * Usage: node .claude/scripts/analyze-token-cache-logs.mjs <log-file-path>
 *
 * Analyzes brainstrike logs to debug token cache issues.
 */

import { readFileSync } from 'fs';

const logFile = process.argv[2];
if (!logFile) {
  console.error('Usage: node analyze-token-cache-logs.mjs <log-file-path>');
  process.exit(1);
}

const raw = readFileSync(logFile, 'utf8');
const logs = JSON.parse(raw);

console.log(`\n=== TOKEN CACHE LOG ANALYSIS ===`);
console.log(`Total log entries: ${logs.length}`);

// Group by scope
const byScope = {};
for (const log of logs) {
  const scope = log.scope || 'unknown';
  byScope[scope] = (byScope[scope] || 0) + 1;
}
console.log(`\n--- Entries by Scope ---`);
for (const [scope, count] of Object.entries(byScope).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${scope}: ${count}`);
}

// Key message analysis
const keyMessages = [
  'Hot cache updated',
  'File indexed',
  'Selection effect triggered',
  'New files to index',
  'triggerIndexing started',
  'triggerIndexing prepared',
  'worker ready',
  'Background indexer state',
  'Hook initialized',
  'token counted',
  'cache hit',
  'cache miss',
];

console.log(`\n--- Key Message Counts ---`);
for (const msg of keyMessages) {
  const count = logs.filter(l =>
    l.message?.toLowerCase().includes(msg.toLowerCase()) ||
    l.serializedArgs?.toLowerCase().includes(msg.toLowerCase())
  ).length;
  console.log(`  "${msg}": ${count}`);
}

// Hot cache update details
const hotCacheUpdates = logs.filter(l =>
  l.message?.includes('Hot cache updated') ||
  l.serializedArgs?.includes('Hot cache updated')
);
console.log(`\n--- Hot Cache Updates (first 10) ---`);
hotCacheUpdates.slice(0, 10).forEach((log, i) => {
  const args = log.args || [];
  const data = args[1] || {};
  console.log(`  ${i + 1}. key=${data.key || 'N/A'}, tokenCount=${data.tokenCount || 'N/A'}, cacheSize=${data.cacheSize || 'N/A'}`);
});

// File indexed details
const fileIndexed = logs.filter(l =>
  l.message === 'File indexed' ||
  l.serializedArgs?.includes('"File indexed"')
);
console.log(`\n--- File Indexed Events (first 10) ---`);
fileIndexed.slice(0, 10).forEach((log, i) => {
  const args = log.args || [];
  const data = args[1] || {};
  console.log(`  ${i + 1}. compositeKey=${data.compositeKey || 'N/A'}, tokenCount=${data.tokenCount || 'N/A'}`);
});

// Selection effect analysis
const selectionEffects = logs.filter(l =>
  l.message === 'Selection effect triggered'
);
console.log(`\n--- Selection Effect Triggers (first 10) ---`);
selectionEffects.slice(0, 10).forEach((log, i) => {
  const args = log.args || [];
  const data = args[1] || {};
  console.log(`  ${i + 1}. selectedFiles=${data.selectedFilesCount}, alreadyIndexed=${data.alreadyIndexed}, isReady=${data.isReady}`);
});

// New files to index
const newFiles = logs.filter(l =>
  l.message === 'New files to index'
);
console.log(`\n--- New Files to Index (first 10) ---`);
newFiles.slice(0, 10).forEach((log, i) => {
  const args = log.args || [];
  const data = args[1] || {};
  console.log(`  ${i + 1}. count=${data.count}, first3=${JSON.stringify(data.first3 || [])}`);
});

// Error messages
const errors = logs.filter(l => l.level === 'error' || l.level === 50);
console.log(`\n--- Errors (${errors.length} total) ---`);
errors.slice(0, 10).forEach((log, i) => {
  console.log(`  ${i + 1}. [${log.scope}] ${log.message || log.serializedArgs?.slice(0, 100)}`);
});

// Check for TokenCache scope (from use-token-cache.ts)
const tokenCacheLogs = logs.filter(l => l.scope === 'TokenCache');
console.log(`\n--- TokenCache Scope Logs (${tokenCacheLogs.length} total) ---`);
tokenCacheLogs.slice(0, 10).forEach((log, i) => {
  console.log(`  ${i + 1}. ${log.message || log.serializedArgs?.slice(0, 100)}`);
});

// Worker messages
const workerLogs = logs.filter(l =>
  l.scope === 'BackgroundTokenIndexer' ||
  l.scope === 'BackgroundTokenIndexerWorker'
);
console.log(`\n--- Background Indexer/Worker Logs (${workerLogs.length} total) ---`);
const workerMsgCounts = {};
for (const log of workerLogs) {
  const msg = log.message || 'unknown';
  workerMsgCounts[msg] = (workerMsgCounts[msg] || 0) + 1;
}
for (const [msg, count] of Object.entries(workerMsgCounts).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  "${msg}": ${count}`);
}

// Timeline analysis - first file indexed vs first hot cache update
const firstFileIndexed = fileIndexed[0];
const firstHotCache = hotCacheUpdates[0];
console.log(`\n--- Timeline Analysis ---`);
if (firstFileIndexed) {
  console.log(`  First "File indexed" at: ${firstFileIndexed.timestamp}`);
}
if (firstHotCache) {
  console.log(`  First "Hot cache updated" at: ${firstHotCache.timestamp}`);
}

// Check build hash (look for main-*.js in userAgent or anywhere)
const buildHashMatch = raw.match(/main-([a-zA-Z0-9]+)\.js/);
if (buildHashMatch) {
  console.log(`\n--- Build Info ---`);
  console.log(`  Build hash: ${buildHashMatch[1]}`);
}

console.log(`\n=== END ANALYSIS ===\n`);
