// SQL-statement-boundary helpers shared by `model-catalog-migration-contract.mjs`.
// Split out (BST-1794 follow-up) purely to keep that file under the repo's
// `noExcessiveLinesPerFile` budget — this is plumbing for the
// `models.updated_at` write guard, not a general-purpose SQL parser, and it
// should stay scoped to what that guard needs.

/**
 * Read a single-quoted SQL string literal starting at `startIndex` (where
 * `sql[startIndex] === "'"`), returning `null` if it is unterminated. Doubled
 * `''` is the standard SQL escape for a literal quote inside the string.
 * Every caller in this file relies on this to skip PAST string-literal
 * content (including any `;`, `(`, or `)` characters inside it) rather than
 * treating it as SQL syntax.
 */
export function readSqlStringLiteral(sql, startIndex) {
  if (sql[startIndex] !== "'") {
    return null;
  }

  let value = '';
  let index = startIndex + 1;
  while (index < sql.length) {
    const char = sql[index];
    if (char !== "'") {
      value += char;
      index += 1;
      continue;
    }

    if (sql[index + 1] === "'") {
      value += "'";
      index += 2;
      continue;
    }

    return { endIndex: index + 1, value };
  }

  return null;
}

/**
 * Read a double-quoted SQL identifier starting at `startIndex` (where
 * `sql[startIndex] === '"'`), returning `null` if it is unterminated. Doubled
 * `""` inside one is the standard SQL escape for a literal quote in the
 * identifier — mirrors `readSqlStringLiteral` but for identifiers, so a `(` or
 * `)` inside a quoted column name (e.g. `"legacy)"`) is never mistaken for
 * paren-nesting syntax.
 */
export function readSqlQuotedIdentifier(sql, startIndex) {
  if (sql[startIndex] !== '"') {
    return null;
  }

  let value = '';
  let index = startIndex + 1;
  while (index < sql.length) {
    const char = sql[index];
    if (char !== '"') {
      value += char;
      index += 1;
      continue;
    }

    if (sql[index + 1] === '"') {
      value += '"';
      index += 2;
      continue;
    }

    return { endIndex: index + 1, value };
  }

  return null;
}

// Matches the START of a whole `UPDATE models ...` or `INSERT INTO models
// (...) ...` statement, including a schema-qualified target in any quoting
// combination — `public.models`, `"public"."models"`, `public."models"` — by
// treating the schema and table as independently optional-quoted identifiers
// rather than one quoted `"public.models"` blob. Never an
// `ALTER TABLE models ALTER COLUMN updated_at ...` schema change — that starts
// with `ALTER`, not `UPDATE`/`INSERT INTO`, so it never matches this pattern.
// The statement's END is found separately by `findModelsStatementEnd`, which
// is string-literal- and nesting-aware (BST-1794 follow-up: a lazy `;`-anchored
// pattern either stopped at a `;` inside a string literal, or — when the
// `models` statement itself had no terminating `;` — kept scanning into an
// unrelated later statement, letting a `providers` write masquerade as a
// `models` one).
export const MODELS_WRITE_STATEMENT_START_PATTERN =
  /\b(?:UPDATE|INSERT\s+INTO)\s+(?:(?:"public"|public)\s*\.\s*)?(?:"models"|models)(?![\w$])/gi;

// Keywords that can legitimately open a new top-level SQL statement. Used by
// `findModelsStatementEnd` to recognize "the `models` statement ended here"
// even when the migration author forgot the trailing `;` (only ever expected
// at the very end of an `up:` block — see `006-embedding-sets-and-columns.ts`,
// which trails off after its last `;` with comments only, never mid-block).
// `WITH` and `SELECT` are deliberately EXCLUDED: both appear legally INSIDE an
// `INSERT INTO models ...` statement (`INSERT ... SELECT ...` and
// `INSERT ... WITH cte AS (...) SELECT ...`), so treating either as a new
// statement's start would end the scan before the `ON CONFLICT (id) DO UPDATE
// SET updated_at = NOW()` clause that follows them, letting it go unseen.
const NEXT_SQL_STATEMENT_KEYWORD_PATTERN =
  /^(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM|ALTER\s+TABLE|CREATE\b|DROP\b|BEGIN\b|COMMIT\b|GRANT\b|REVOKE\b)\b/i;

/**
 * Is the statement-keyword match at `index` actually the `DO UPDATE SET` (or
 * `DO NOTHING`, etc.) clause of a preceding `ON CONFLICT`, rather than the
 * start of a new statement? `DO UPDATE` is the one case where a recognized
 * statement-start keyword legitimately appears mid-statement.
 */
function isPrecededByDoKeyword(sql, index) {
  // 40 characters is comfortably more than `DO` plus the run of whitespace
  // (spaces/newlines/indentation) a migration author could plausibly put
  // between `DO` and the following `UPDATE`/`NOTHING`, so the lookback never
  // needs to grow to catch a real `DO ... UPDATE` clause.
  return /\bDO\s*$/i.test(sql.slice(Math.max(0, index - 40), index));
}

/**
 * Find the end of the SQL statement that starts at `searchFrom` (the index
 * right after a `MODELS_WRITE_STATEMENT_START_PATTERN` match), scanning
 * string-literal- and paren-nesting-aware so that a `;` inside a quoted value
 * (e.g. `'b;c'`) never ends the statement early, and a missing terminating
 * `;` never lets the scan run on into an unrelated following statement.
 * Returns `sql.length` when the statement runs to the end of the block (the
 * one legitimate no-trailing-`;` shape).
 */
export function findModelsStatementEnd(sql, searchFrom) {
  let depth = 0;
  let index = searchFrom;

  while (index < sql.length) {
    const char = sql[index];

    if (char === "'") {
      const parsed = readSqlStringLiteral(sql, index);
      index = parsed ? parsed.endIndex : sql.length;
      continue;
    }

    if (char === '(') {
      depth += 1;
      index += 1;
      continue;
    }

    if (char === ')') {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }

    if (depth === 0 && char === ';') {
      return index;
    }

    if (
      depth === 0 &&
      index > searchFrom &&
      /\s/.test(sql[index - 1]) &&
      NEXT_SQL_STATEMENT_KEYWORD_PATTERN.test(sql.slice(index)) &&
      !isPrecededByDoKeyword(sql, index)
    ) {
      return index;
    }

    index += 1;
  }

  return sql.length;
}

/**
 * If `afterTableSource` (the SQL immediately following the matched
 * `INSERT INTO models` / `UPDATE models` table reference) opens with an
 * `INSERT` target-column list — `(col1, col2, ...)` before `VALUES`,
 * `SELECT`, `WITH`, or `DEFAULT VALUES` — return that list's source text.
 * Returns `null` for a plain `UPDATE` (no column list follows the table name)
 * or an `INSERT ... DEFAULT VALUES` (no parenthesized column list at all).
 * The column list itself is comma-separated, optionally double-quoted
 * identifiers. A double-quoted identifier can legally contain `(`/`)`
 * (e.g. `"legacy)"`), so those are tracked and skipped over rather than
 * counted as nesting; single-quoted string literals are skipped the same way
 * via `readSqlStringLiteral` even though a bare column list should not
 * contain one, purely for robustness against malformed input.
 */
export function extractInsertColumnListSource(afterTableSource) {
  const openMatch = afterTableSource.match(/^\s*\(/);
  if (!openMatch) {
    return null;
  }

  const openIndex = openMatch[0].length - 1;
  let depth = 0;
  let index = openIndex;
  while (index < afterTableSource.length) {
    const char = afterTableSource[index];

    if (char === '"') {
      const parsed = readSqlQuotedIdentifier(afterTableSource, index);
      index = parsed ? parsed.endIndex : afterTableSource.length;
      continue;
    }

    if (char === "'") {
      const parsed = readSqlStringLiteral(afterTableSource, index);
      index = parsed ? parsed.endIndex : afterTableSource.length;
      continue;
    }

    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return afterTableSource.slice(openIndex + 1, index);
      }
    }

    index += 1;
  }

  return null;
}

/**
 * Split a column-list source into its individual identifier tokens. Each
 * token is a double-quoted identifier read verbatim via
 * `readSqlQuotedIdentifier` (case-sensitive, may contain `,`/`(`/`)`), or a
 * bare run of identifier characters between commas otherwise. Anything else
 * (whitespace, commas, stray characters) is skipped.
 */
function parseColumnListIdentifiers(columnListSource) {
  const identifiers = [];
  let index = 0;
  while (index < columnListSource.length) {
    const char = columnListSource[index];

    if (char === '"') {
      const parsed = readSqlQuotedIdentifier(columnListSource, index);
      if (!parsed) {
        break;
      }
      identifiers.push({ quoted: true, value: parsed.value });
      index = parsed.endIndex;
      continue;
    }

    if (/[A-Za-z0-9_$]/.test(char)) {
      let end = index + 1;
      while (end < columnListSource.length && /[A-Za-z0-9_$]/.test(columnListSource[end])) {
        end += 1;
      }
      identifiers.push({ quoted: false, value: columnListSource.slice(index, end) });
      index = end;
      continue;
    }

    index += 1;
  }

  return identifiers;
}

/**
 * Does `columnName` (e.g. `updated_at`) appear in `columnListSource` as a
 * whole target column? An `INSERT INTO models (id, name, updated_at) VALUES
 * (...)` writes `updated_at` through this column list exactly like an
 * explicit `updated_at = ...` assignment would. Column tokens are parsed via
 * `parseColumnListIdentifiers` so a quoted identifier like `"updated_at)"` —
 * whose unquoted content isn't the bare identifier `updated_at` — is compared
 * as the single literal identifier it is, not matched by a substring or
 * unbalanced-quote heuristic; a bare (unquoted) token matches case-
 * insensitively, matching Postgres's own unquoted-identifier folding, while a
 * quoted token `"updated_at"` matches case-sensitively.
 */
export function insertColumnListWritesColumn(afterTableSource, columnName) {
  const columnList = extractInsertColumnListSource(afterTableSource);
  if (columnList === null) {
    return false;
  }

  return parseColumnListIdentifiers(columnList).some((identifier) =>
    identifier.quoted
      ? identifier.value === columnName
      : identifier.value.toLowerCase() === columnName.toLowerCase()
  );
}
