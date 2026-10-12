import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { Schema } from 'effect';

export const decodeRoots = makeThrowingDecoder(
  Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      kind: Schema.Literals(['path', 'fsa', 'snapshot', 'legacy', 'worktree']),
    })
  )
);

export const decodeSelectedCollections = makeThrowingDecoder(
  Schema.Array(Schema.Struct({ id: Schema.NonEmptyString }))
);
