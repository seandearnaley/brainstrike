# Agent family colors — evidence

Supports `docs/agents/database.md` § "ASSISTANT THREAD GROUP PRESENTATION".

Migration 143 widened the durable group and delegated child checks to the 18 semantic IDs. Migration 144 retains those IDs and accepts canonical `family:<hue-tenths>:<tone>` child tokens in `brainstrike_delegated_conversations`: hue ranges from 0 to 3599 and tone from 0 to 999, with no leading zeroes. Root and group colors stay semantic IDs. Rollback rejects remaining family tokens; it never remaps saved identities.

`@brainstrike/types/agent-color` owns validation and light/dark CSS variable generation. The desktop host reads every persisted descendant color under the authorized root inside the child admission transaction, chooses an unused family token, and writes it to the existing child row. A retry reuses that saved color and display name. The allocator scores OKLab distance against the parent and siblings, with a narrower hue window for grandchildren; its bounded search rejects when it cannot find a free token.

Guards: `packages/types/__tests__/agent-color.test.ts`, `packages/db/__tests__/migration-144-agent-family-colors.integration.test.ts`, and `apps/desktop/src/__tests__/assistant-server/delegated-family-color.integration.test.ts`.
