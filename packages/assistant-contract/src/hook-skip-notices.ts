/**
 * The visible wording of a CLI-first host `hooks.skipped` file, shared by the
 * desktop thread view and the CLI. Each surface names its own way to trust a
 * project file, so the reader passes that remedy in.
 */

/** The `hooks.skipped` file fields a notice reads; the host protocol owns the row. */
export interface HookSkipNoticeInput {
  readonly detail: string;
  readonly path: string;
  readonly reason: 'changed' | 'invalid' | 'over-budget' | 'unreadable' | 'untrusted';
}

export interface HookSkipNotice {
  readonly detail: string;
  readonly label: string;
}

const LABELS: Readonly<Record<HookSkipNoticeInput['reason'], string>> = {
  changed: 'Project hooks changed since trusted',
  invalid: 'Hooks file invalid',
  'over-budget': 'Hook phase disabled',
  unreadable: 'Hooks file unreadable',
  untrusted: 'Project hooks not trusted',
};

/** `trustRemedy` follows the detail only when trusting the file would run it. */
export function describeHookSkip(skip: HookSkipNoticeInput, trustRemedy: string): HookSkipNotice {
  const needsTrust = skip.reason === 'untrusted' || skip.reason === 'changed';
  return {
    detail: `${skip.path}: ${skip.detail}${needsTrust ? ` — ${trustRemedy}` : ''}`,
    label: LABELS[skip.reason],
  };
}
