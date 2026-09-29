# Flat-scan loader rules — evidence

Supports `docs/agents/workspace-context.md` §
"Four rules every flat-scan loader must follow".
Read before adding a fourth `.brainstrike/` scanning feature or changing the persona/lens loaders. BST-936 records why each rule exists.

The record below is the prose that stood in the contract before it was
distilled to the contract/evidence idiom, extracted verbatim. The contract
holds the rules that are true today; where the two differ, the contract wins.

## Record

Learned the hard way: the lens loader mirrored the persona loader faithfully
and inherited three real defects with it. Both now follow these; a fourth
loader must too, and `/commands` should adopt them if it ever grows an
authoring UI.

1. **Reserve the id from the FILENAME, before reading or parsing** — through
   ONE exported contract function shared by the loader and the parser, so the
   reserved key and the real id cannot drift. Without pre-parse reservation, a
   BROKEN project-tier file silently hands its name to a same-named global
   file carrying different behaviour — the worst failure mode available to a
   config system.
   **Reserve through the FULL id gate, not half of it.** Personas use
   `resolveUserPersonaId` (derivation + built-in collision), NOT bare
   `deriveUserPersonaId`: a name owned by a built-in can never load in any
   tier, so it must not reserve — otherwise the second same-named file is
   mislabelled "shadowed" when the honest answer is "a built-in owns this
   name", which both files deserve to be told. Lenses use `deriveLensId`
   (they have no built-in namespace). A filename that derives no valid id
   reserves nothing.
2. **The count cap counts ENTRIES (valid + invalid), not accepted items** —
   otherwise a directory of malformed files extends the scan across every
   mounted root instead of consuming the bound. Because that makes the cap
   *destructive* (an earlier root can exhaust the budget before a later tier
   is read at all), exhausting it is REPORTED per directory, not just logged.
3. **The directory-listing bound is NOT the item cap.** `listDir`'s
   `maxEntries` counts every directory entry (READMEs, subdirs, backups), so
   deriving it from the cap lets junk evict real files from the listing before
   they are read. Both use `cap * 2 + 1`. Every partially-scanned directory —
   whether the listing truncated or the cap was exhausted first — lands in
   `incompleteDirs` with its reason, so "my file is missing" always has a
   visible cause. In the UI these read as AMBER warnings, never destructive
   red: red is reserved for "you must fix a file".
4. **Suppressed duplicates are VISIBLE, as `status: 'shadowed'` ENTRIES**
   carrying `shadowedBy: { absPath, sourceRootId? }` — naming the file that
   WON, because "which copy is live?" is the author's actual question. This is
   `skill-scan.ts`'s existing shape (`packages/agent/src/skills/`), adopted
   deliberately rather than inventing a third: the skills panel already says
   *"Shadowed by … in `<absPath>` — this copy is inactive."* and both other
   panels now match it. A shadowed file is its own state, NOT an error —
   precedence is not an authoring mistake — so it renders muted, and
   `listLenses` prints a `SHADOWED` line naming the winner.

