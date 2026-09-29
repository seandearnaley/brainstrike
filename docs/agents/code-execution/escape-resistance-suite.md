# The escape-resistance red team and its README — evidence

Supports `docs/agents/code-execution.md` § "Escape-resistance suite". Read this
and `packages/agent/src/__tests__/fence-escape-resistance.README.md` before
changing either file. The contract holds the rules; this file is the record of
what the suite covers.

Corrected at extraction (verified against
`packages/agent/src/fence/fence-policy.ts` and the README's non-guarantee 5):
"there is no always-deny list for WRITES" is now too broad. The policy layer
refuses an `allowWrite` at or under an always-denied credential store, because
on Linux a write grant there re-opens the store for reading. Write grants
remain otherwise broad — there is still no general always-deny list for writes.

`packages/agent/src/__tests__/fence-escape-resistance.integration.spec.ts`, with
`fence-escape-resistance.README.md` beside it. The contract suite above proves
the executor behaves; this one attacks it — traversal, symlink escape, fork /
multiprocessing / depth-2 grandchild inheritance, raw sockets that ignore the
proxy, DNS as an exfil channel, resource exhaustion shape, host-env exfiltration,
descendant survival across a policy change, and cancellation in both positions.

**Read the README before changing either file.** It is the honest statement of
what the fence does and does NOT guarantee (reads are permissive by default;
exfiltration via an allow-listed domain is unaddressed; CPU/memory are bounded
only by the timeout; kernel-level attacks defeat it entirely; there is no
always-deny list for WRITES), it carries the mutation-kill table proving each
security assertion actually detects the hole it names, and it records the srt
re-green procedure. srt is an OS fence, not a VM — mode two (ADR-0003) is the
answer for adversarial code, and this suite must not be read as claiming
otherwise.
