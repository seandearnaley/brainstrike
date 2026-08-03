# @brainstrike/settings-ui

Settings and status UI for Brainstrike. Persistent application state lives in
`@brainstrike/app-state`; this package consumes that state through explicit
subpath imports and owns no persistence stores.

The package intentionally has no root barrel or wildcard export. Import the
smallest documented subpath needed by the composition root.
