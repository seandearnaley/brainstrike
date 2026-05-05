export function escapePGliteLiveQueryFormatPercents(
  query: string,
  params: readonly unknown[] | null | undefined
): string {
  if (!(params && params.length > 0)) {
    return query;
  }

  return query.replace(/%+/g, (percentRun) =>
    percentRun.length % 2 === 0 ? percentRun : `${percentRun}%`
  );
}
