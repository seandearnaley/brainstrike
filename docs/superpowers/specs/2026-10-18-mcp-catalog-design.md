# MCP Catalog — Design

**Date:** 2026-10-18
**Status:** Approved 2026-10-18 (design); spec approved by the owner 2026-10-18; implemented on this branch.
**Scope:** desktop Settings → AI Tools → MCP Config, the host's MCP settings
authority, and a catalog in `@brainstrike/assistant-contract`.
**Nature:** a functional placeholder. Each integration gets its own live proof and
hardening later; this change makes one-click installs exist and work end to end
up to the vendor's sign-in.

## 1. Problem

Adding an MCP server today means hand-editing `mcp/mcp.config.json` in the
profile. The owner wants a page with one-click installs of the vendors' official
remote MCP servers, starting with Linear, GitHub, Atlassian and GitLab, which
BrainStrike will support as first-class integrations.

## 2. Vendor facts (verified 2026-10-18)

Checked against vendor docs and unauthenticated probes of the live servers
(401 challenges, `.well-known` documents). Every vendor serves Streamable HTTP.

| Vendor | Endpoint | Auth BrainStrike can use | Notes |
| --- | --- | --- | --- |
| Linear | `https://mcp.linear.app/mcp`; read-only `https://mcp.linear.app/mcp/readonly` | OAuth 2.1 with DCR (also CIMD); API key as `Authorization: Bearer` | `/sse` removed. Proven working in BrainStrike on 2026-10-18 (68 tools). |
| GitHub | `https://api.githubcopilot.com/mcp/`; read-only `https://api.githubcopilot.com/mcp/readonly` | Personal access token as `Authorization: Bearer` (fine-grained recommended) | **No DCR, no CIMD.** OAuth needs a pre-registered OAuth/GitHub App with a client secret. No remote server for GHES. |
| Atlassian | `https://mcp.atlassian.com/v2/mcp` | OAuth 2.1; DCR and CIMD advertised in live metadata but undocumented | Cloud only. The loopback redirect (`http://127.0.0.1:<port>`) passes the default domain allowlist. API tokens only when an org admin enables them. v1 moves to v2 tools on 2027-03-01. |
| GitLab | `https://gitlab.com/api/v4/mcp` | OAuth 2.0 with DCR (`mcp` scope only, 10 registrations/hour/IP); fine-grained PAT | GA in 19.5. On gitlab.com a group Owner must enable "MCP client access". Read-only exists only as a tool-allowlist header. |

Primary sources: <https://linear.app/docs/mcp>,
<https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md>,
<https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md>,
<https://support.atlassian.com/atlassian-ai-gateway/docs/get-started-with-the-atlassian-remote-mcp-server/>,
<https://support.atlassian.com/security-and-access-policies/docs/available-atlassian-mcp-server-domains/>,
<https://docs.gitlab.com/user/model_context_protocol/mcp_server/>.

## 3. Decisions

| # | Question | Decision |
| --- | --- | --- |
| D1 | How does the GitHub install authenticate? | **Paste a token.** Install takes a fine-grained PAT, stores it in the profile credential store and writes a `bearer` credential reference. GitHub documents this path for third-party hosts; shipping a client secret in the binary is rejected. |
| D2 | Read-only installs? | **Only where the vendor enforces it:** Linear and GitHub offer Read-only / Read & write. Atlassian and GitLab install read & write. |
| D3 | Deployments | **Cloud only:** linear.app, github.com, Atlassian Cloud, gitlab.com. |
| D4 | Where installs land in dev | **The current profile's config, as today.** Sharing MCP config across dev branch profiles is a separate ownership decision. |
| D5 | Live proof | **None in this change.** Each integration is proven separately later. |
| D6 | Catalog source | **Curated, typed data checked into the contract**; a unit test decodes every entry through the config grammar. No runtime fetch of the MCP Registry. |
| D7 | Who writes the config | **`McpSettingsAuthority`, through a typed install method.** The renderer names a catalog entry; it never composes config text for an install. |

## 4. Architecture

```
settings-ui  McpCatalogSection ──(installMcpCatalogServer prop from ToolsSettingsOperations)
                 │
desktop      page-content.tsx ── mcpSettings.request('mcp/config/install', …)
                 │
agent-host   protocol-mcp-settings.ts (params/result) · ports.ts · mcp-settings-connection.ts
                 │
host-capabilities  McpSettingsAuthority.installCatalogServer
                 ├─ catalog lookup ............ @brainstrike/assistant-contract/mcp-catalog
                 ├─ token storage ............. McpBearerCredentialWriter.create / delete
                 └─ JSONC append + reload ..... jsonc-parser modify/applyEdits → configFile.writeText
```

### 4.1 Catalog — `packages/assistant-contract/src/mcp-catalog.ts` (new)

A typed constant exported only through a new `./mcp-catalog` subpath (never the
package root, like `./mcp-config`). Each entry:

- `id`: the configured server name it installs (`linear`, `github`, `atlassian`, `gitlab`);
- `name`, `description` (one line), `docsUrl`;
- `auth`: `'oauth'` or `'token'`; a token entry carries `token: { createUrl, label }`
  (GitHub: `https://github.com/settings/personal-access-tokens/new`);
- `urls`: `read-write` (required) and `read-only` (optional). Entries carry no
  OAuth scopes; each server's own challenge decides them.

Every variant produces a server with `transport: 'streamable-http'`,
`protocol: 'auto'`, and either `auth: { type: 'oauth-user' }` or a `bearer`
reference. The catalog content is the table in §2 restricted by D2 and D3.

### 4.2 Install — `McpSettingsAuthority.installCatalogServer`

Host method `mcp/config/install`, params
`{ catalogId: string, access: 'read-only' | 'read-write', token?: string }`,
result in the same success/failure union shape as `mcp/config/write`. It runs on
`#trackOperation`, like `writeConfigText`.

1. Resolve the entry and variant from the catalog. The renderer cannot supply a
   URL through this method.
2. Read and parse the current config text. Refuse when it does not parse; a broken
   file is never overwritten.
3. Refuse when a server with the entry's `id` already exists.
4. Token entries: require a token matching the bearer token pattern, then
   `bearerCredentials.create(token)` returns a fresh
   `{ store: 'mcp-credentials', id: <uuid> }` reference. OAuth entries refuse a
   supplied token.
5. Append the server object to `servers` with `jsonc-parser` `modify` and
   `applyEdits`, so comments and formatting survive.
6. Write through the same stop-watcher → `configFile.writeText` →
   restart-watcher → reload path that `writeConfigText` uses. Extract that path
   into a private helper that both methods call, instead of copying it.
7. The token's fate follows whether the file was written. A write that returned a
   failure (including a conflict) or threw before writing deletes the token, and
   the error says so. A failure after a successful write (watcher restart or
   reload) keeps the token, because the config already references it, and
   rethrows. A failed delete is reported beside the original failure.

`bearer-credential.ts` gains `createSecretsMcpBearerCredentialWriter`, whose
`create(token)` and `delete(reference)` use the same `SecretsService` as the
reader (`saveKey` / `deleteKey` on `mcp-credentials:<uuid>`). The bearer module
stays the single owner of that key namespace, and the reader's three
composition sites stay unchanged. `McpSettingsAuthorityOptions` gains the writer
as a required dependency; `desktop-node-mcp.ts` builds it.

Factory reset: the keyring `clearAll` sweeps every account in the secrets
namespace, which includes `mcp-credentials:<uuid>`. A test proves it (§6).

### 4.3 UI — `packages/settings-ui/src/settings/tools/mcp-catalog-section.tsx` (new)

Rendered at the top of `McpConfigPanel`, the MCP Config tab, which already sits
behind the `mcpAvailable` capability gate (desktop only).

- The cards render from `@brainstrike/assistant-contract/mcp-catalog`, which
  settings-ui already depends on; the catalog module has no Node-only imports.
- One card per entry: name, description, auth badge (OAuth / Token), docs link
  and an Install button.
- A Read-only / Read & write toggle only on entries with a `read-only` variant.
  It defaults to Read & write, the vendor's default endpoint.
- A card whose `id` is already a configured server shows Installed instead of
  Install. Configured ids come from the existing `getMcpServerStatus()` host
  snapshot, re-read after an install and on every config change.
- A token entry's Install opens a dialog with a password field, the vendor's
  "create token" link, and Save. The token goes straight to the install request
  and is never held in UI state after it returns.
- Failures render inline on the card with the host's message. Nothing is retried
  silently.
- Install is disabled while the config editor below holds unsaved text, so a
  later Save cannot overwrite an install with stale text. After an install the
  editor reloads the file.
- After an OAuth install the server appears in the Tools tab with its existing
  status row and Connect button. No new auth UI.

`ToolsSettingsOperations` gains an optional `installMcpCatalogServer`; the card
grid renders only when it is supplied (capability by omission).

### 4.4 Compare-and-swap writes

`McpConfigFile.readText` returns the text's `revision`, the lowercase hex SHA-256 of its
UTF-8 bytes; an absent file has the revision of `''`. `writeText(content, baseRevision)`
writes nothing and returns `conflict: true` when the file's revision differs. Host
protocol v12 carries it: `mcp/config/read` returns `revision`, `mcp/config/write`
requires `baseRevision`, and write and install successes return the new `revision`.
The editor saves on the revision it last loaded or saved. An install commits on the
revision it read, so an edit during the keychain write refuses it and removes its token.
An external writer can still race the adjacent check and write; that is acceptable here.
A conflict reloads the runtime from the changed file. The editor allows one save in
flight, and after a conflict it keeps the editor text but locks Save until a reload.
When a write fails and the watcher restart or reload then fails too, the write's
failure is reported first. An install the host committed stays a success when the
later Settings refresh fails; that failure gets its own alert.

## 5. Error handling

Every refusal is a visible failure result with a specific message: unknown
catalog id, unknown access variant, already configured, config does not parse,
token missing, token malformed, token not accepted for an OAuth entry, write
failed, write failed with the stored token not removed, a write on a stale base
(the config changed on disk since it was read), and an install whose config
changed while installing. No fallback endpoint, no silent overwrite, no partial
state left behind without being reported.

## 6. Testing

Red first for each behavior.

- **Contract:** every catalog variant decodes through `McpServerSchema`; ids are
  unique and valid configured server ids.
- **Bearer authority:** `create` stores the token and returns a fresh UUID
  reference that the reader resolves; `delete` removes it; a malformed token is
  refused before anything is stored.
- **Settings authority:**
  - appends to a commented config and keeps the comments;
  - refuses a duplicate id and leaves the file untouched;
  - refuses an unparseable config and leaves the file untouched;
  - token install stores the secret and writes its reference;
  - a failing write after the secret was stored deletes the secret and reports the failure;
  - the installed server reaches the runtime through the normal reload.
- **Reset:** a stored `mcp-credentials:<uuid>` is gone after the keyring `clearAll`.
- **settings-ui:** card states (Install / Installed / error), the toggle only on
  Linear and GitHub, token dialog validation, nothing rendered without the
  operation.
- **App flow:** on a disposable profile, install Linear read-only from the card
  and observe the config entry and the server listed as authentication required.
  No vendor sign-in (D5).

## 7. Out of scope (named follow-ups)

- Live proof and hardening per integration (Atlassian DCR/CIMD, GitLab group
  setting and DCR limits, GitHub token permissions).
- A Remove action. Until it exists, deleting a token entry by hand in the editor
  leaves its keychain secret until a factory reset.
- Self-managed GitLab, GitHub data residency (`copilot-api.<sub>.ghe.com/mcp`).
- Read-only for Atlassian (scope subsets) and GitLab (tool allowlist header).
- Sharing MCP config across dev branch profiles.
- GitHub OAuth through a registered BrainStrike app (would need a
  pre-registered-client config field).
