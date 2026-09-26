# Agent family colors — evidence

Supports `docs/agents/database.md` § "ASSISTANT THREAD GROUP PRESENTATION".

Migration 143 widened the durable group and delegated child checks to the 18 semantic IDs. Migration 144 retains those IDs and accepts canonical `family:<hue-tenths>:<tone>` child tokens in `brainstrike_delegated_conversations`: hue ranges from 0 to 3599 and tone from 0 to 999, with no leading zeroes. Root and group colors stay semantic IDs. Rollback rejects remaining family tokens; it never remaps saved identities.

`@brainstrike/types/agent-color` owns validation and light/dark CSS variable generation. The desktop host reads every persisted descendant color under the authorized root inside the child admission transaction, chooses an unused family token, and writes it to the existing child row. A retry reuses that saved color and display name. The allocator scores OKLab distance against the parent and siblings, with a narrower hue window for grandchildren; its bounded search rejects when it cannot find a free token.

Guards: `packages/types/__tests__/agent-color.test.ts`, `packages/db/__tests__/migration-144-agent-family-colors.integration.test.ts`, and `apps/desktop/src/__tests__/assistant-server/delegated-family-color.integration.test.ts`.

## Whole-tree separation and explicit refresh (2026-09-25)

The 28-degree descendant window produced nearly identical cousin accents despite unique numeric tokens. Allocation now scores every occupied tree accent in both light and dark mode across the full hue circle, preferring a parent-relative candidate only among choices with near-best separation. Family accents are bounded to the sRGB gamut and carry contrast-aware ink; names, hierarchy, status and parent-color cues remain independent identification aids.

The user can explicitly refresh saved child colors from root customization. The desktop host validates the owned graph and performs the read, allocation and color-only writes inside the existing callback transaction. Active or paused work rejects refresh. Saved names, native identities, configuration, messages, invocations and permissions are unchanged; opening a conversation or retrying admission never recolors it. No schema or persistent preference is added. Renderer invalidation rereads the saved colors while retaining mounted child conversation state.

Guards: shared color tests; desktop delegated family-color and refresh endpoint tests; app-shell saved sidebar and workspace repaint tests; desktop delegated-workspace reload smoke.
