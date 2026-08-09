export function formatGrepProjectionPageRange(args: {
  readonly kept: number;
  readonly lowerBound: boolean;
  readonly offset: number;
  readonly total: number;
}): string {
  const totalLabel = `${args.total}${args.lowerBound ? '+' : ''}`;
  if (args.kept === 0) {
    return `empty@offset=${args.offset}/${totalLabel}`;
  }
  return `${args.offset + 1}-${args.offset + args.kept}/${totalLabel}`;
}

export function formatGrepContentHeader(args: {
  readonly kept: number;
  readonly lowerBound: boolean;
  readonly offset: number;
  readonly total: number;
}): string {
  return `grep content ${formatGrepProjectionPageRange(args)}`;
}

export function formatGrepContentRow(line: number, text: string, isMatch = true): string {
  return `  ${line}${isMatch ? ':' : '-'} ${text}`;
}
