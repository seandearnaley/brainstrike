# Secret scanning

`scripts/secret-scan.mjs` looks for high-confidence credential shapes (provider
API keys, cloud access key IDs, source-control and chat tokens, private key
blocks). Findings print a redacted preview and a SHA-256 hash of the match.

- Where it runs:
  - `pnpm secrets:scan`: tracked files; part of `pnpm check` and CI.
  - `pnpm secrets:scan:staged`: staged index; lefthook pre-commit.
- On a real finding: remove the credential, and rotate it if it was ever
  committed or shared.
- On a reviewed false positive: prefer changing the fixture so it no longer looks
  like a credential. Otherwise add a narrow entry to `secret-scan.config.json`:

  ```json
  {
    "filePath": "path/to/file",
    "ruleId": "rule-name",
    "secretHash": "sha256-hash-from-scanner-output",
    "reason": "Why this is safe to allow"
  }
  ```

- Config keys in `secret-scan.config.json`:
  - `excludePaths`: repo-relative paths or simple globs (scanner docs and tests).
  - `allowlistedFindings`: entries keyed by `filePath`, `ruleId` and `secretHash`.
    Never allowlist a whole file to unblock a commit.
