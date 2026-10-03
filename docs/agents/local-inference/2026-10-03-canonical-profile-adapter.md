# Canonical profile and inference adapter delivery

The adapter resolves authorized PGlite embedding-set metadata without writes.
Local execution uses the public pinned-plan resolver and the existing hidden
document payload. Hosted identity is preserved; unsupported execution fails
visibly. Resolving a profile does not enable vectors or change saved choices.

Accepted prerequisites are `88d23c6705fee1915fd8ede2c8cb5e35c7cad686`;
the adapter is `b3114c480a5a99de077d30c9632cb337e064050f`, corrected by
`c75c3e2a3afefbe0406c68a8896aea409476b3ed`. Independent review found no
remaining defects in the corrected chain. The desktop canonical-ingestion
dependency is already integrated; this delivery does not duplicate it.

Review reproduced a sparse input admitted to authority and transport and
returned as sparse success. Wholly sparse and mixed sparse acceptance cases
failed against the original source. The mandatory correction rejects missing
own entries before authority or transport, without filtering or filling holes.
The corrected 39 profile cases, three actual PGlite metadata cases and 13
public pinned-plan cases passed on the source branch with normal hooks.

The injected document relay must settle only after physical hidden-renderer
completion or joined host retirement. Held-promise cases establish this
adapter's cancel/join ownership; they do not qualify the concrete manager.
Production main activation, the manager settlement correction, actual vector
publication/search/reset and running-app/platform qualification remain pending.
