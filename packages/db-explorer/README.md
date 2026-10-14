# @brainstrike/db-explorer

Collections/database presentation, import integration and CSV/context export
helpers. The UI composes existing data ports; it does not become a catalog,
transcript or indexing writer.

## Actual public surface

[`index.ts`](src/index.ts) and [`package.json`](package.json) own exports.
`DatabaseDemoPanel`, `useDatabaseDemoData` and `useImportFlow` are existing
composition points. Internal import services are not a zero-argument public
`FileImportCoordinator` or a settings-only service constructor.

The data hook owns collection-scoped queries, cached view models, lazy chunk
loading and export loading. Preserve active-collection isolation, canonical
membership, safe errors and the mapper/helper boundary. Database-backed consumers
require their admitted repository/live-query context; a component name does not
establish desktop renderer SQL authority. Desktop catalog/native-index capabilities
retain their separate host owners.

Import execution borrows repository ports, canonical chunking and the existing
queue/provider seams. Use [the import guide](../file-import/README.md) for those
interfaces. Cancel/retire through the actual owner, and preserve source/input
identity before publication; progress alone is not committed coverage.

CSV helpers in [`csv-export-utils.ts`](src/csv-export-utils.ts) expose
`generateCSV`, `createCSVBlob`, filename generation and the current specialized
export routines. Keep their escaping and record/column contracts. Read the
exported component props when composing a surface instead of duplicating them here.

Persistent preference/state stores belong to `@brainstrike/app-state`; feature
view/cache state does not create another durable product fact. See
[database](../../docs/agents/database.md) and
[UI](../../docs/agents/ui-conventions.md) contracts.

## Development

Local consumers use `workspace:*`; the manifest owns dependency versions and
scripts. Follow
[validation guidance](../../docs/agents/ci-quality.md).
