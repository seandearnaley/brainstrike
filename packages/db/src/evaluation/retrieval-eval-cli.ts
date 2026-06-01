// Keep stdout machine-readable for CI consumers.
process.env['LOG_LEVEL'] = 'silent';

const { runRetrievalEvaluation, serializeRetrievalEvaluationReport } = await import(
  './retrieval-eval-runner.js'
);

const report = await runRetrievalEvaluation();
process.stdout.write(`${serializeRetrievalEvaluationReport(report)}\n`);

if (!report.passed) {
  process.exitCode = 1;
}
