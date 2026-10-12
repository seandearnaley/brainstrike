/** The set with one domain ticked or unticked. */
export function tickDomain(
  ticked: ReadonlySet<string>,
  domain: string,
  checked: boolean
): ReadonlySet<string> {
  const next = new Set(ticked);
  if (checked) {
    next.add(domain);
  } else {
    next.delete(domain);
  }
  return next;
}
