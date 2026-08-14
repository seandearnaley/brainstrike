const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

async function getJson({ fetchImpl, requestTimeoutMs, token, url }) {
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
    method: 'GET',
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`GitHub Actions metadata request failed with HTTP ${response.status}`);
  }
  return response.json();
}

export async function fetchCurrentMainFailureMetadata({
  baseSha,
  repository,
  token,
  fetchImpl = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  if (!SHA_PATTERN.test(baseSha)) {
    throw new Error('baseSha must be a full lowercase Git SHA');
  }
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must be an owner/repository slug');
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('GITHUB_TOKEN is required for read-only Actions metadata');
  }
  if (!(Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs > 0)) {
    throw new Error('requestTimeoutMs must be a positive integer');
  }

  const apiRoot = `https://api.github.com/repos/${repository}`;
  const runsPayload = await getJson({
    fetchImpl,
    requestTimeoutMs,
    token,
    url: `${apiRoot}/actions/workflows/test.yml/runs?branch=main&event=push&status=completed&per_page=20`,
  });
  if (!Array.isArray(runsPayload?.workflow_runs)) {
    throw new Error('GitHub Actions runs payload is malformed');
  }
  const runs = runsPayload.workflow_runs.filter(
    (run) =>
      run?.head_sha === baseSha &&
      run.head_branch === 'main' &&
      run.event === 'push' &&
      run.status === 'completed' &&
      run.conclusion === 'failure'
  );
  if (runs.length !== 1 || !Number.isSafeInteger(runs[0].id)) {
    return { jobs: [], runs };
  }
  const jobsPayload = await getJson({
    fetchImpl,
    requestTimeoutMs,
    token,
    url: `${apiRoot}/actions/runs/${runs[0].id}/jobs?filter=latest&per_page=100`,
  });
  if (!Array.isArray(jobsPayload?.jobs)) {
    throw new Error('GitHub Actions jobs payload is malformed');
  }
  return { jobs: jobsPayload.jobs, runs };
}
