# Vercel Preview is advisory — evidence

Supports `docs/agents/ci-quality.md` § "Vercel Preview is advisory". Read this
before proposing to make the `Vercel` status required, or to work around a red
capacity status. The contract holds the rules; this file is the reasoning and
the vendor references.

The Vercel GitHub integration reports a `Vercel` commit status on pull
requests, but it is intentionally absent from the default-branch ruleset's
required checks. The merge gate is the five always-present `test.yml` checks
listed above. This separation prevents provider capacity from being confused
with a code-quality result while keeping real Preview failures visible.

When `Vercel` is red:

1. Inspect the status description and target deployment before classifying it.
   A provider-capacity description (rather than a build or deployment failure
   log) means no build was evaluated; an actual failed deployment or build log
   is a product failure and remains blocking. Do not depend on a specific
   provider URL slug because integration URLs can change.
2. Verify the current repository ruleset rather than relying on an old PR or
   this prose. `gh api repos/seandearnaley/brainstrike/rulesets/4797672`
   should match the required checks listed above under
   `required_status_checks`.
3. For capacity-only failures, do not push a no-op commit or restart the
   45-minute GitHub Actions pipeline. Once the exact-head required checks and
   reviews are clean, the PR may merge with the advisory capacity status red.
4. Do not claim Preview QA occurred when capacity prevented a deployment. If
   the change specifically requires a live Preview acceptance check, restore
   capacity and perform that check before merge.

This is not a silent-success fallback: the original Vercel status stays red
and visible. Repeated quota exhaustion is an account-capacity problem to
provision, not a reason to weaken or rewrite the integration. Vercel documents
deployment and concurrency quotas in its
[platform limits](https://vercel.com/docs/limits); GitHub documents that only
[status checks selected by a ruleset are required to pass](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-status-checks-to-pass-before-merging).
