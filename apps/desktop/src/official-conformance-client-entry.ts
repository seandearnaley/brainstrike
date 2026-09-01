import { runOfficialConformanceProcess } from './official-conformance-client-process';

void runOfficialConformanceProcess(process.argv.slice(2), process.env).then((exitCode) => {
  process.exitCode = exitCode;
});
