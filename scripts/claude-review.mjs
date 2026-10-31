// The I/O half of .github/workflows/claude-review.yml; the decisions live in
// scripts/lib/claude-review.mjs. Three commands, one per workflow step:
//
//   prepare  decide full, follow-up or skip; write the prompt and the run state
//   run      stream the prompt to the Claude CLI on stdin and keep its result
//   publish  post one PR review with inline comments, resolve fixed threads,
//            and record the reviewed head in the status comment
//
// The model never touches GitHub. It gets read-only file tools on the checkout
// and returns structured findings; publish validates every line against the
// PR's hunks before posting anything. CLAUDE_REVIEW_DRY_RUN=1 makes publish
// print what it would post instead.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildPrompt,
  changeFingerprint,
  deserializeFiles,
  findingTitle,
  isOwnFinding,
  newWork,
  parseDiff,
  placeFinding,
  renderPrDiff,
  resultSchema,
  reviewBody,
  reviewState,
  selectFindings,
  serializeFiles,
  stateMarker,
} from './lib/claude-review.mjs';

// GITHUB_TOKEN posts as github-actions[bot]; GraphQL names the same account
// without the suffix.
const REST_BOT = 'github-actions[bot]';
const GRAPHQL_BOT = 'github-actions';
// About 170k tokens of diff. Past it the largest patches are listed, not shown,
// and the reviewer reads those files itself.
const DIFF_BUDGET = 600 * 1024;
const COMMENT_LIMIT = 65_000;
const HISTORY_LIMIT = 15;

const env = process.env;
const workDir = () => path.join(env.RUNNER_TEMP, 'claude-review');
const workFile = (name) => path.join(workDir(), name);
const readJson = (name) => JSON.parse(readFileSync(workFile(name), 'utf8'));
const short = (sha) => sha.slice(0, 7);

// Bodies go to gh on stdin, never as arguments: argv refuses NUL bytes, and a
// review that quotes the diff can carry one.
const gh = (args, input) =>
  execFileSync('gh', args, { encoding: 'utf8', input, maxBuffer: 64 << 20 });
const ghJson = (args, input) => JSON.parse(gh(args, input));
const ghPages = (route) => ghJson(['api', route, '--paginate', '--slurp']).flat();

// The checkout keeps no credentials (the reviewer can read .git/config), so a
// fetch authenticates through environment-only git config for that one call.
function git(args) {
  const auth = Buffer.from(`x-access-token:${env.GH_TOKEN}`).toString('base64');
  return execFileSync('git', ['-c', 'core.quotePath=false', '--literal-pathspecs', ...args], {
    encoding: 'utf8',
    env: {
      ...env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `http.${env.GITHUB_SERVER_URL}/.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}`,
    },
    maxBuffer: 256 << 20,
  });
}

const summary = (text) => appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n\n`);
const runUrl = () =>
  `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;

function statusComment(repository, number) {
  return ghPages(`repos/${repository}/issues/${number}/comments`).findLast(
    (comment) => comment.user?.login === REST_BOT && reviewState(comment.body)
  );
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved path line subjectType comments(first: 20) { nodes { author { login } body } } }
      }
    }
  }
}`;

/** This workflow's earlier findings, numbered F1.. for the model to refer to. */
function priorFindings(repository, number) {
  const [owner, name] = repository.split('/');
  const pages = ghJson([
    'api',
    'graphql',
    '--paginate',
    '--slurp',
    '-f',
    `query=${THREADS_QUERY}`,
    '-f',
    `owner=${owner}`,
    '-f',
    `name=${name}`,
    '-F',
    `number=${number}`,
  ]);
  return pages
    .flatMap((page) => page.data.repository.pullRequest.reviewThreads.nodes)
    .filter((thread) => isOwnFinding(thread.comments.nodes[0], GRAPHQL_BOT))
    .map((thread, index) => ({
      file: thread.subjectType === 'FILE',
      id: `F${index + 1}`,
      line: thread.line,
      path: thread.path,
      replies: thread.comments.nodes
        .slice(1)
        .filter((comment) => comment.author?.login !== GRAPHQL_BOT)
        .map(
          (comment) =>
            `${comment.author?.login ?? 'ghost'}: ${comment.body.slice(0, 600).replaceAll('\n', ' ')}`
        ),
      resolved: thread.isResolved,
      threadId: thread.id,
      title: findingTitle(thread.comments.nodes[0].body),
    }));
}

// The rules come from the base branch, never the PR, as Anthropic's managed
// reviewer does: a PR cannot loosen the review it gets.
function baseReviewMd(repository, baseRef) {
  try {
    return gh([
      'api',
      '-H',
      'Accept: application/vnd.github.raw',
      `repos/${repository}/contents/REVIEW.md?ref=${encodeURIComponent(baseRef)}`,
    ]);
  } catch {
    return null;
  }
}

export function prepare() {
  mkdirSync(workDir(), { recursive: true });
  const { pull_request: pr } = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const repository = env.GITHUB_REPOSITORY;
  const { number } = pr;
  const head = pr.head.sha;
  const state = { head, mode: 'skip', number, repository };
  try {
    if (git(['rev-parse', 'HEAD']).trim() !== head) {
      throw new Error(`The checkout is not the PR head ${head}.`);
    }
    const status = statusComment(repository, number);
    const last = status ? reviewState(status.body) : null;
    const lastHead = last?.head ?? null;
    Object.assign(state, { lastHead, statusCommentId: status?.id ?? null });
    if (lastHead === head) {
      state.reason = `\`${short(head)}\` is already reviewed.`;
      return;
    }

    const files = ghPages(`repos/${repository}/pulls/${number}/files`);
    const prFiles = new Map();
    for (const file of files) {
      for (const [filePath, entry] of parseDiff(file.patch ?? '', file.filename)) {
        prFiles.set(filePath, entry);
      }
    }
    state.change = changeFingerprint(files);
    if (lastHead && state.change === last.change) {
      // The PR adds and removes the same lines it did: an empty commit, a clean
      // rebase or a base merge. Record the new head so the next follow-up
      // starts here.
      Object.assign(state, {
        advance: true,
        reason: `No new changes since \`${short(lastHead)}\`.`,
      });
      return;
    }

    // A full review normally has none, but one after the status comment was
    // deleted (the way to ask for a fresh full pass) must not re-post them.
    const prior = priorFindings(repository, number);
    let diff;
    let omitted = [];
    let touched = null;
    if (lastHead) {
      try {
        git(['fetch', '--no-tags', '--depth=1', 'origin', lastHead]);
      } catch (error) {
        // Only a full review could cover this push now, and a second full one
        // is the owner's call. Fail, which holds the PR, rather than pass an
        // unreviewed push.
        throw new Error(
          `The last reviewed commit ${short(lastHead)} can no longer be fetched (${error.message.split('\n')[0]}). Delete the "Claude review" status comment and re-run this job for a fresh full review.`
        );
      }
      const incremental = git([
        'diff',
        '--no-color',
        '--no-ext-diff',
        lastHead,
        head,
        '--',
        ...files.map((file) => file.filename),
      ]);
      touched = newWork(parseDiff(incremental), prFiles);
      // A push that only removes lines can still be the fix for an open
      // finding, so it gets a follow-up that may resolve but not post.
      if (touched.size === 0 && !prior.some((finding) => !finding.resolved)) {
        Object.assign(state, {
          advance: true,
          reason: `No new lines since \`${short(lastHead)}\` and no open findings to recheck.`,
        });
        return;
      }
      diff = incremental;
      state.mode = 'followup';
    } else {
      ({ diff, omitted } = renderPrDiff(files, DIFF_BUDGET));
      state.mode = 'full';
    }

    const prompt = buildPrompt({
      diff,
      fence: `UNTRUSTED-${randomUUID()}`,
      head,
      lastHead,
      mode: state.mode,
      number,
      omitted,
      pr,
      prior,
      repository,
      reviewMd: baseReviewMd(repository, pr.base.ref),
      touched,
    });
    writeFileSync(workFile('prompt.md'), prompt);
    Object.assign(state, {
      prFiles: serializeFiles(prFiles),
      prior,
      touched: touched && serializeFiles(touched),
    });
  } catch (error) {
    state.mode = 'skip';
    state.reason = `Preparation failed: ${error.message}`;
    process.exitCode = 1;
  } finally {
    writeFileSync(workFile('state.json'), JSON.stringify(state));
    appendFileSync(env.GITHUB_OUTPUT, `mode=${state.mode}\n`);
    if (state.reason) {
      summary(`**Claude review:** ${state.reason}`);
    }
  }
}

export function run() {
  const args = [
    '--print',
    '--model',
    env.CLAUDE_REVIEW_MODEL,
    '--effort',
    env.CLAUDE_REVIEW_EFFORT,
    // No command or code tools, no settings files from the checkout (so no
    // hooks), file tools confined to the checkout, and nothing approved beyond
    // reading it.
    '--restricted',
    '--tools',
    'Read,Grep,Glob',
    '--permission-mode',
    'dontAsk',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(resultSchema),
  ];
  const prompt = openSync(workFile('prompt.md'), 'r');
  let child;
  try {
    child = spawnSync('claude', args, {
      encoding: 'utf8',
      maxBuffer: 64 << 20,
      stdio: [prompt, 'pipe', 'inherit'],
    });
  } finally {
    closeSync(prompt);
  }
  if (child.error) {
    throw child.error;
  }
  let result;
  try {
    result = JSON.parse(child.stdout);
  } catch {
    throw new Error(
      `The Claude CLI exited ${child.status} without JSON: ${String(child.stdout).slice(0, 500)}`
    );
  }
  summary(
    `**Claude review run:** ${result.num_turns ?? '?'} turns, ${Math.round((result.duration_ms ?? 0) / 1000)} s, ${result.permission_denials?.length ?? 0} tool calls denied.`
  );
  if (child.status !== 0 || result.is_error || !result.structured_output) {
    throw new Error(
      `The Claude CLI did not return a review: ${result.subtype ?? child.status} ${String(result.result ?? '').slice(0, 500)}`
    );
  }
  writeFileSync(workFile('result.json'), JSON.stringify(result.structured_output));
}

function post(args, payload) {
  if (env.CLAUDE_REVIEW_DRY_RUN === '1') {
    process.stdout.write(
      `--- would call gh ${args.join(' ')}\n${JSON.stringify(payload, null, 2)}\n`
    );
    return { html_url: '(dry run)' };
  }
  return ghJson(args, JSON.stringify(payload));
}

function postReview({ body, comments, head, number, repository }) {
  const route = [
    'api',
    '-X',
    'POST',
    `repos/${repository}/pulls/${number}/reviews`,
    '--input',
    '-',
  ];
  // Every comment was checked against GitHub's hunks, so a refusal is a bug
  // here: fail the job, which holds the PR, rather than post findings without
  // the threads the merge protection counts.
  return post(route, { body, comments, commit_id: head, event: 'COMMENT' });
}

/** A file-level comment, for a finding outside the hunks; reviews can't carry one. */
function postFileComment({ comment, head, number, repository }) {
  post(['api', '-X', 'POST', `repos/${repository}/pulls/${number}/comments`, '--input', '-'], {
    ...comment,
    commit_id: head,
  });
}

function resolveThread(threadId) {
  const mutation =
    'mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }';
  try {
    post(['api', 'graphql', '-f', `query=${mutation}`, '-f', `id=${threadId}`], { threadId });
  } catch (error) {
    process.stderr.write(
      `::warning::Could not resolve review thread ${threadId}: ${error.message.split('\n')[0]}\n`
    );
  }
}

/** Record the reviewed head in the one status comment, edited in place. */
function recordHead(state, line) {
  const previous = state.statusCommentId
    ? ghJson(['api', `repos/${state.repository}/issues/comments/${state.statusCommentId}`]).body
    : '';
  const history = [line, ...previous.split('\n').filter((row) => row.startsWith('- '))].slice(
    0,
    HISTORY_LIMIT
  );
  const body = `### Claude review\n\nThe first ready push gets one full review; each later push gets a follow-up on its new commits only.\n\n${history.join('\n')}\n\n${stateMarker(state.head, state.change)}`;
  const route = state.statusCommentId
    ? [
        'api',
        '-X',
        'PATCH',
        `repos/${state.repository}/issues/comments/${state.statusCommentId}`,
        '--input',
        '-',
      ]
    : [
        'api',
        '-X',
        'POST',
        `repos/${state.repository}/issues/${state.number}/comments`,
        '--input',
        '-',
      ];
  post(route, { body });
}

export function publish() {
  const state = readJson('state.json');
  const range = state.lastHead
    ? `\`${short(state.lastHead)}..${short(state.head)}\``
    : `\`${short(state.head)}\``;
  if (state.mode === 'skip') {
    if (state.advance) {
      recordHead(state, `- ${range}: no new changes, nothing to review. [run](${runUrl()})`);
    }
    return;
  }
  const live = ghJson(['api', `repos/${state.repository}/pulls/${state.number}`]);
  if (live.head.sha !== state.head) {
    summary(
      `**Claude review:** the PR moved on to \`${short(live.head.sha)}\`; that push's run reviews it.`
    );
    return;
  }
  if (!existsSync(workFile('result.json'))) {
    throw new Error('The review step left no result.');
  }
  const result = readJson('result.json');
  const prFiles = deserializeFiles(state.prFiles);
  const touched = state.touched && deserializeFiles(state.touched);
  const selected = new Set(selectFindings(result.findings, state.mode));
  const comments = [];
  const fileComments = [];
  const inBody = [];
  let outOfScope = 0;
  for (const finding of result.findings) {
    if (!selected.has(finding)) {
      continue;
    }
    const placed = placeFinding(finding, { prFiles, touched });
    if (placed.kind === 'inline') {
      comments.push(placed.comment);
    } else if (placed.kind === 'file') {
      fileComments.push(placed.comment);
    } else if (placed.kind === 'body') {
      inBody.push(finding);
    } else {
      outOfScope += 1;
    }
  }
  const open = new Map(
    state.prior.filter((finding) => !finding.resolved).map((finding) => [finding.id, finding])
  );
  const resolved = [...new Set(result.resolve)].map((id) => open.get(id)).filter(Boolean);
  const counts = { inBody, notPosted: result.findings.length - selected.size, outOfScope };

  // A follow-up with nothing new to say posts no review: resolving threads and
  // editing the status comment notify no one.
  let reviewUrl = null;
  if (state.mode === 'full' || comments.length || fileComments.length || inBody.length) {
    let body = reviewBody({
      ...counts,
      effort: env.CLAUDE_REVIEW_EFFORT,
      head: state.head,
      lastHead: state.lastHead,
      mode: state.mode,
      model: env.CLAUDE_REVIEW_MODEL,
      resolved,
      summary: result.summary,
    });
    if (body.length > COMMENT_LIMIT) {
      body = `${body.slice(0, COMMENT_LIMIT)}\n\n…cut at GitHub's comment limit; the full review is in the [run](${runUrl()}).`;
    }
    reviewUrl = postReview({
      body,
      comments,
      head: state.head,
      number: state.number,
      repository: state.repository,
    }).html_url;
  }
  for (const comment of fileComments) {
    postFileComment({
      comment,
      head: state.head,
      number: state.number,
      repository: state.repository,
    });
  }
  for (const finding of resolved) {
    resolveThread(finding.threadId);
  }

  const parts = [`${comments.length} posted inline`];
  if (fileComments.length) {
    parts.push(`${fileComments.length} as file comments`);
  }
  if (inBody.length) {
    parts.push(`${inBody.length} in the review body`);
  }
  if (resolved.length) {
    parts.push(`${resolved.length} earlier finding(s) resolved`);
  }
  if (counts.notPosted || outOfScope) {
    parts.push(`${counts.notPosted + outOfScope} not posted`);
  }
  const link = reviewUrl ? ` [review](${reviewUrl}),` : '';
  recordHead(
    state,
    `- ${range} ${state.mode === 'full' ? 'full review' : 'follow-up'}: ${parts.join(', ')}.${link} [run](${runUrl()})`
  );
  summary(`**Claude review (${state.mode}):** ${parts.join(', ')}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const commands = { prepare, publish, run };
  const command = commands[process.argv[2]];
  if (!command) {
    throw new Error('Expected prepare, run or publish.');
  }
  command();
}
