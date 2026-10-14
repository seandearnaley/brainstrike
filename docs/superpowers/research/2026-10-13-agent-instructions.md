# Repository instructions: concise rules and task-specific references

Primary sources checked 13 October 2026. Vendor recommendations and empirical findings are distinguished below; the Brainstrike recommendations are a synthesis, not a measured performance claim.

## Recommendation

Keep the root instructions to the decisions an agent must get right across ordinary tasks: owner boundaries, project-specific constraints, practical validation commands, and a small set of contextual pointers. Keep durable architectural decisions in ADRs and specialist references near their subject. Archive historical receipts and remove duplicated or superseded instructions from active policy. A one-page root is a maintainability choice for this repository, not a scientifically established optimum.

## Vendor guidance

**OpenAI.** Its current Codex guidance says to revisit accumulated instructions, avoid requiring a stack of documents or a full repository map before every edit, and point to documents for the situations where they matter. It recommends minimal routers for workflows with supporting material and warns that elaborate itineraries can overconstrain capable models. Its examples specify relevant document triggers rather than universal prerequisites. These are vendor observations and recommendations, particularly for GPT-6 Astra. [OpenAI: Rethinking skills and prompts](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra).

Codex discovers instructions from the repository root toward the working directory, with later guidance taking precedence. Its default combined 32 KiB limit describes loading behavior; it is not a recommended document length or evidence that filling the limit helps. [OpenAI: Custom instructions with AGENTS.md](https://developers.openai.com/codex/guides/agents-md).

**Anthropic.** Claude Code's best-practices guide recommends instructions that apply broadly and provide knowledge the agent cannot infer from code. It includes unusual commands, testing conventions, architectural decisions, environment quirks, and non-obvious gotchas; it excludes standard language practices, detailed API documentation, volatile facts, tutorials, and file-by-file descriptions. It recommends pruning unnecessary lines and observing whether instruction edits change actual behavior. [Anthropic: Best practices](https://code.claude.com/docs/en/best-practices).

Its memory guide adds concrete, verifiable phrasing, consistent rules, and scoped instructions for relevant paths. Imported files still load at launch, so splitting a long document into automatic imports does not reduce its context cost. Its under-200-line recommendation is vendor advice for CLAUDE.md, not a cross-agent optimum. [Anthropic: Memory](https://code.claude.com/docs/en/memory).

**GitHub.** Copilot guidance recommends short, self-contained statements with broad relevance, since repository instructions accompany chat requests. Path-specific instructions avoid putting specialist guidance in the repository-wide file. Agent-instruction support varies by Copilot surface, so one should not assume every client loads the same files. [GitHub: Response customization](https://docs.github.com/en/copilot/concepts/prompting/response-customization), [GitHub: Instruction support](https://docs.github.com/en/copilot/reference/custom-instructions-support).

## Empirical evidence and its limits

Gloaguen et al., *Evaluating AGENTS.md*, v3 (29 September 2026), evaluate Python tasks using SWE-bench and 138 CTXbench instances from 12 repositories. Context files increase cost and exploration without a statistically significant general improvement in task success. Developer-written files outperform generated files, but their gain against no context is not significant. The length analysis finds no clear dependency between file length and success or cost; extra mandated work explains cost better than length alone. The authors recommend specific additional instructions beyond existing documentation. [Paper, sections 4–6 and Appendix B](https://arxiv.org/html/2602.11988v3).

Khatri's smaller preprint tests 17 tasks from three Python repositories across Claude Code and Codex. It detects no correctness improvement from full instructions or selective retrieval. Small task counts, agent differences, and a larger selective corpus in two repositories limit interpretation. It does not establish that selective delivery is universally better. [Paper, sections 3–5](https://arxiv.org/html/2607.27250v1).

Neither study tests Brainstrike's TypeScript/Electron stack or these current models. Reduced instruction bytes are directly measurable; improved correctness, latency, or total inference cost must be demonstrated separately.

## Applying this to Brainstrike

These are editorial criteria inferred from the sources above and the owner's requested simplification:

| Action | Criterion |
| --- | --- |
| Keep | A current, non-obvious requirement changes a likely implementation decision: protected-profile boundaries, CI authorization, real validation commands, or a durable architectural constraint. State the rule once. |
| Scope | Guidance matters only for a subsystem or workflow. Give a clear trigger and a link to its owning reference; avoid importing every reference into each task. |
| Archive | Milestone status, dated acceptance receipts, resolved incident narratives, platform screenshots, or historical exceptions have evidentiary value but no current instructional role. |
| Delete from active policy | Duplicates, superseded rules, generic advice already enforced by tools, exhaustive file inventories, and recurring receipt/documentation rituals that do not prevent a current defect. |

Validate the rewrite against representative future work by observing missed constraints, unnecessary reads, and repeated validation. Keep measured context reduction separate from behavioral claims. Do not add a new receipt pipeline or prose-count test to validate concise instructions.
