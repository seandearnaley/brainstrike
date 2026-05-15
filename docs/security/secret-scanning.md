# Secret Scanning

Brainstrike runs a repo-local secret scanner in two places:

- `pnpm secrets:scan` scans tracked repository files and runs in the static CI gate.
- `pnpm secrets:scan:staged` scans staged Git index contents and runs in pre-commit.

The scanner looks for high-confidence credential shapes such as provider API keys, cloud access key IDs, source-control tokens, chat tokens, and private key blocks. Findings print a redacted preview plus a SHA-256 hash of the matched secret.

## Local Triage

1. Remove the credential from the change.
2. Rotate the credential if it was ever committed or shared.
3. Re-run `pnpm secrets:scan:staged` before committing.

For a reviewed false positive, add a scoped entry to `secret-scan.config.json` under `allowlistedFindings`:

```json
{
  "filePath": "path/to/file",
  "ruleId": "rule-name",
  "secretHash": "sha256-hash-from-scanner-output",
  "reason": "Why this is safe to allow"
}
```

Keep allowlist entries as narrow as possible. Do not allowlist broad files just to unblock a commit; prefer changing fixture values so they do not resemble real credentials.

## Config

`secret-scan.config.json` supports:

- `excludePaths`: repository-relative paths or simple glob patterns for generated docs or scanner tests.
- `allowlistedFindings`: reviewed false positives keyed by `filePath`, `ruleId`, and `secretHash`.
