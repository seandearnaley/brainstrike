---
name: fix-nightly
description: Claim one nightly-alert Linear issue, reproduce its failing test, and hand back a red-first fix for review.
argument-hint: <BST-issue>
disable-model-invocation: true
---

# Fix one nightly failure

Fix the failing or flaky test that Linear issue `$ARGUMENTS` names, **red-first**: one commit whose test goes red on the reported failure, then the commit that turns it green. The work ends as a pull request with `Fixes $ARGUMENTS`, or as evidence only when the area is hot (step 3). A human reviews it, and the human and the merge queue merge it. Your branch is the only ref you write.

## Who does the credentialed steps

`NIGHTLY_FIX_OUT` set means you run inside `.github/workflows/nightly-fix-agent.yml`. There your GitHub token is read-only and the workflow does the credentialed steps around you.

| Step | In CI (`NIGHTLY_FIX_OUT` set) | Locally |
| --- | --- | --- |
| Claim | done before you start; the issue is in `$NIGHTLY_FIX_OUT/issue.md`, tonight's failure first | step 1 |
| Push and open the PR | the workflow publishes your commits with `$NIGHTLY_FIX_OUT/pr.md` | `git push -u origin <branch>`, `gh pr create` |
| Comment the evidence | the workflow posts `$NIGHTLY_FIX_OUT/evidence.md` | comment it on the issue |

Locally, write `pr.md` and `evidence.md` in a scratch directory instead.

## Steps

1. **Claim** (locally only). The claim is the lock. Read the issue with the Linear tools. If its state is In Progress, Done or Canceled, someone holds it: report who and stop. Otherwise comment ``Claimed by `<you>` ``, then set yourself as assignee and move it to In Progress. Done when you hold the claim or have stopped.
2. **Read the failure.** The latest failure is the evidence. The description is the first night's: it names the workflow, spec path, full test title (`[project] › describe › title`) and job. In CI, `issue.md` opens with tonight's failure and its run; locally, use the newest `Red again:` or `Passed only on retry:` comment, else the description. A `Nightly red: <workflow>` issue with no spec lists red jobs that showed no failing test: work from that job's log (`gh run view <run-id> --log-failed`) instead of a spec. Done when you can name the spec, the project and the latest failing run's id.
3. **Check the area's history.** Name the product paths the failing test exercises: the source files and directories under test, not the spec. Run `pnpm defect-density -- <those paths>`. It counts commits only: locally, also count the area's `nightly-alert` issues from the same 14 days with the Linear tools, and three or more makes it HOT too. In CI you have no Linear access, so write in `evidence.md` that issues were not counted. If any path is HOT, the area needs a redesign, not another patch: write `evidence.md` with your root-cause observations across the listed commits, the script's output and a recommendation to redesign, then stop with no commits (locally, comment it on the issue). If the script fails, say so in `evidence.md` and stop the same way. Done when the script exits 0, or you have stopped.
4. **Collect the evidence.** Download that run's test results: `gh run download <run-id> --pattern '*-test-results' --dir <dir>`. In CI the run is `$NIGHTLY_FIX_RUN_ID` and the directory is `$NIGHTLY_FIX_OUT/artifacts`. They are kept one day. If they have expired, say so in the evidence and reproduce from the spec alone. Read the failing test's `error-context.md`, screenshot and `trace.zip`. Done when you know what the test saw when it failed.
5. **Provision like the failing job.** Find the job in `.github/workflows/<workflow file>` and run its setup steps in order: install, build, system packages, the Electron binary and the like. You are on the same runner image, so a hosted-only failure (2-vCPU timing) can reproduce here. Done when the lane's command can start.
6. **Reproduce.** Run only that test, with the lane's own flags plus a grep for its title. For example, from `apps/desktop`: `pnpm exec playwright test e2e/<spec> --project=<project> --grep "<title>" --workers=1 --retries=0`. For a flaky test add `--repeat-each=10`. Done when it goes red on the reported failure (same assertion or timeout). If ten runs stay green, record that and go to step 9 with no fix: a change without a reproduction is a guess.
7. **Commit the red proof.** Create `nightly-fix/<issue, lower case>` from your checkout. Commit the smallest test that fails on this defect, the narrowest one that does: a unit or integration test when the cause lives there, the E2E spec when only it can see it. If the reproducing spec is already that test, the proof is its red run, and you have nothing to commit here. Run it and keep the red output. Done when the commit, or the spec, is red for the reported reason.
8. **Fix and go green.** Fix the root cause in the code under test. Never lengthen a timeout or add a retry to make the test pass. A timing-shaped failure goes to `evidence.md` with its measurements; drop your commits and go to step 9 with no fix. Commit the fix with conventional messages ending `($ARGUMENTS)`; the hooks run as usual. Rerun the red proof and the reproducing spec until both are green, then the touched package's tests. Done when the red proof is green and those tests pass.
9. **Hand off.** Write `pr.md`: its first line is the PR title, a conventional title ending `($ARGUMENTS)`. The rest is the body: root cause, the red run (an output excerpt), the fix, the checks you ran, and what you did not cover. Write `evidence.md` for the issue: whether it reproduced, the root cause, and the PR or why there is none. In CI, stop here; locally, finish with the table's push, PR and comment.

## Boundaries

- The job has no provider API keys, so app tests run against cassettes and fixtures. Recording cassettes is the owner's job.
- Use disposable profiles and fake credentials, as every test in this repository does.
- Fix only this issue; a hot area (step 3) stops the run instead. Another failure you notice goes in `evidence.md`, not in this branch.
