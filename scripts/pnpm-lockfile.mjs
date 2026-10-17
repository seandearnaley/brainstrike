import { parseAllDocuments } from 'yaml';

// pnpm 12 prepends its package-manager graph to the application lockfile.
// Keep these namespaces separate: security/catalog guards inspect the app graph.
export function parsePnpmLockfile(source) {
  const documents = parseAllDocuments(source);
  for (const document of documents) {
    if (document.errors.length > 0) {
      throw document.errors[0];
    }
  }
  const applications = documents
    .map((document) => document.toJS())
    .filter((value) => value && Object.hasOwn(value, 'settings'));
  if (applications.length !== 1) {
    throw new Error('Expected exactly one application document in the pnpm lockfile.');
  }
  const application = applications[0];
  for (const field of ['importers', 'packages', 'snapshots']) {
    if (!application[field] || typeof application[field] !== 'object') {
      throw new Error(`Application lockfile requires ${field}.`);
    }
  }
  return application;
}
