import { Schema } from 'effect';

/** Token-free by construction: a state and the account's email. */
const ChatGptSignInStatusSchema = Schema.Union(
  [
    Schema.Struct({ state: Schema.Literal('signing_in') }),
    Schema.Struct({ email: Schema.optional(Schema.String), state: Schema.Literal('signed_out') }),
    Schema.Struct({
      email: Schema.optional(Schema.String),
      firstSignIn: Schema.optional(Schema.Boolean),
      state: Schema.Literal('signed_in'),
    }),
  ],
  { mode: 'oneOf' }
);

/** Sign in with ChatGPT (ADR-0038), for the launching desktop's private client only. */
export const CHATGPT_SIGN_IN_METHOD_SCHEMAS = {
  'auth/chatgpt/cancel': Schema.Record(Schema.String, Schema.Never),
  /** Answers once the browser sign-in finishes; `newAccount` registers another account. */
  'auth/chatgpt/sign-in': Schema.Struct({ newAccount: Schema.optional(Schema.Boolean) }),
  'auth/chatgpt/sign-out': Schema.Record(Schema.String, Schema.Never),
  /** `settled` answers once no sign-in is waiting for the browser. */
  'auth/chatgpt/status': Schema.Struct({ settled: Schema.optional(Schema.Boolean) }),
} as const;

export const CHATGPT_SIGN_IN_RESULT_SCHEMAS = {
  'auth/chatgpt/cancel': Schema.Struct({ cancelled: Schema.Literal(true) }),
  'auth/chatgpt/sign-in': ChatGptSignInStatusSchema,
  'auth/chatgpt/sign-out': Schema.Struct({ revoked: Schema.Boolean }),
  'auth/chatgpt/status': ChatGptSignInStatusSchema,
} as const;
