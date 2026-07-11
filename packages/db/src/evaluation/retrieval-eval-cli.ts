// Keep stdout machine-readable for CI consumers.
process.env['LOG_LEVEL'] = 'silent';

const { runRetrievalEvaluation } = await import('./retrieval-eval-runner.js');
const { runLexicalEvaluation } = await import('./lexical-eval-runner.js');

const vectorReport = await runRetrievalEvaluation();
const lexicalReport = await runLexicalEvaluation();
process.stdout.write(
  `${JSON.stringify({ lexical: lexicalReport, vector: vectorReport }, null, 2)}\n`
);

if (!(vectorReport.passed && lexicalReport.passed)) {
  process.exitCode = 1;
}
