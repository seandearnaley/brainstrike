#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_CONFIG_PATH = 'secret-scan.config.json';

const DEFAULT_CONFIG = {
  allowlistedFindings: [],
  excludePaths: [],
};

const BINARY_SNIFF_BYTES = 8192;
const GIT_OUTPUT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const EXPECTED_READ_ERROR_CODES = new Set([
  'EACCES',
  'EISDIR',
  'ENOENT',
  'ENOTDIR',
  'EPERM',
]);

const SECRET_RULES = [
  {
    id: 'private-key',
    pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    id: 'openai-api-key',
    pattern: /\bsk-(?:(?:proj|svcacct)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{20,})\b/g,
  },
  {
    id: 'anthropic-api-key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: 'aws-access-key-id',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    id: 'github-token',
    pattern: /\b(?:github_pat_[A-Za-z0-9_]{82,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,})\b/g,
  },
  {
    id: 'hugging-face-token',
    pattern: /\bhf_[A-Za-z0-9]{30,}\b/g,
  },
  {
    id: 'slack-token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: 'google-api-key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
];

const REDACTED_MARKERS = ['redacted', 'example', 'placeholder', 'changeme'];

function isRedactedExample(value) {
  const normalized = value.toLowerCase();
  return REDACTED_MARKERS.some((marker) => normalized.includes(marker));
}

export function hashSecret(secret) {
  return createHash('sha256').update(secret).digest('hex');
}

function getLineAndColumn(text, index) {
  const prefix = text.slice(0, index);
  const lines = prefix.split('\n');
  return {
    line: lines.length,
    column: lines.at(-1).length + 1,
  };
}

export function scanText({ filePath, text }) {
  const findings = [];

  for (const rule of SECRET_RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const secret = match[0];
      if (isRedactedExample(secret)) {
        continue;
      }
      const position = getLineAndColumn(text, match.index ?? 0);
      findings.push({
        column: position.column,
        filePath,
        line: position.line,
        ruleId: rule.id,
        secretHash: hashSecret(secret),
        secretPreview: redactSecret(secret),
      });
    }
  }

  return findings.sort((a, b) => {
    if (a.filePath !== b.filePath) {
      return a.filePath.localeCompare(b.filePath);
    }
    if (a.line !== b.line) {
      return a.line - b.line;
    }
    return a.column - b.column;
  });
}

function redactSecret(secret) {
  if (secret.length <= 8) {
    return '<redacted>';
  }
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function normalizeConfig(config) {
  return {
    allowlistedFindings: Array.isArray(config.allowlistedFindings)
      ? config.allowlistedFindings
      : [],
    excludePaths: Array.isArray(config.excludePaths) ? config.excludePaths : [],
  };
}

export function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }
  const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  return normalizeConfig(parsed);
}

function globToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '::DOUBLE_STAR::')
    .replaceAll('*', '[^/]*')
    .replaceAll('::DOUBLE_STAR::', '.*');
  return new RegExp(`^${escaped}$`);
}

function isExcluded(filePath, config) {
  return config.excludePaths.some((pattern) => globToRegExp(pattern).test(filePath));
}

export function filterAllowedFindings(findings, config) {
  const allowlisted = new Set(
    config.allowlistedFindings.map(
      (entry) => `${entry.filePath}\0${entry.ruleId}\0${entry.secretHash}`
    )
  );

  return findings.filter((finding) => {
    const key = `${finding.filePath}\0${finding.ruleId}\0${finding.secretHash}`;
    return !allowlisted.has(key);
  });
}

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: GIT_OUTPUT_MAX_BUFFER_BYTES,
  });
}

function splitNullDelimited(value) {
  return value.split('\0').filter(Boolean);
}

function getTrackedFiles() {
  return splitNullDelimited(git(['ls-files', '-z']));
}

function getStagedFiles() {
  return splitNullDelimited(git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']));
}

function isExpectedReadFailure(error) {
  return (
    error instanceof Error &&
    'code' in error &&
    EXPECTED_READ_ERROR_CODES.has(String(error.code))
  );
}

function isProbablyBinaryFile(filePath) {
  let fileDescriptor;
  try {
    fileDescriptor = openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(BINARY_SNIFF_BYTES);
    const bytesRead = readSync(fileDescriptor, buffer, 0, BINARY_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    if (fileDescriptor !== undefined) {
      closeSync(fileDescriptor);
    }
  }
}

function readTrackedFile(filePath) {
  if (isProbablyBinaryFile(filePath)) {
    return null;
  }
  return readFileSync(filePath, 'utf8');
}

function readProvidedFile(filePath) {
  return readFileSync(filePath, 'utf8');
}

function readStagedFile(filePath) {
  return git(['show', `:${filePath}`]);
}

export function scanFileList({ config, files, readFile }) {
  const findings = [];
  for (const filePath of files) {
    if (isExcluded(filePath, config)) {
      continue;
    }
    let text;
    try {
      text = readFile(filePath);
    } catch (error) {
      if (isExpectedReadFailure(error)) {
        continue;
      }
      throw error;
    }
    if (text === null) {
      continue;
    }
    findings.push(...scanText({ filePath, text }));
  }
  return filterAllowedFindings(findings, config);
}

function parseArgs(argv) {
  const parsed = {
    configPath: DEFAULT_CONFIG_PATH,
    files: [],
    mode: 'all',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--all') {
      parsed.mode = 'all';
    } else if (arg === '--staged') {
      parsed.mode = 'staged';
    } else if (arg === '--files') {
      parsed.mode = 'files';
      index += 1;
      while (index < argv.length && !argv[index].startsWith('--')) {
        parsed.files.push(argv[index]);
        index += 1;
      }
      index -= 1;
    } else if (arg === '--config') {
      index += 1;
      parsed.configPath = argv[index];
    } else if (arg === '--help' || arg === '-h') {
      parsed.mode = 'help';
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function printHelp() {
  console.log(`Usage: node scripts/secret-scan.mjs [--all|--staged|--files <path...>] [--config <path>]

Modes:
  --all      Scan tracked repository files (default).
  --staged   Scan staged file contents from the Git index.
  --files    Scan the provided file paths from the working tree.
`);
}

function formatFinding(finding) {
  return [
    `${finding.filePath}:${finding.line}:${finding.column}`,
    finding.ruleId,
    finding.secretPreview,
    `sha256:${finding.secretHash}`,
  ].join('  ');
}

function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'help') {
    printHelp();
    return 0;
  }

  const config = loadConfig(args.configPath);
  const scan =
    args.mode === 'staged'
      ? { files: getStagedFiles(), readFile: readStagedFile }
      : args.mode === 'files'
        ? { files: args.files, readFile: readProvidedFile }
        : { files: getTrackedFiles(), readFile: readTrackedFile };

  const findings = scanFileList({ config, files: scan.files, readFile: scan.readFile });
  if (findings.length === 0) {
    console.log(`Secret scan passed (${scan.files.length} file${scan.files.length === 1 ? '' : 's'} checked).`);
    return 0;
  }

  console.error(`Secret scan found ${findings.length} potential credential${findings.length === 1 ? '' : 's'}:`);
  for (const finding of findings) {
    console.error(`  ${formatFinding(finding)}`);
  }
  console.error(
    `\nIf this is a reviewed false positive, add its filePath/ruleId/secretHash to ${args.configPath}.`
  );
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli();
}
