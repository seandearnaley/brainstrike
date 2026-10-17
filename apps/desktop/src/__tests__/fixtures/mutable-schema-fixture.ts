/** Tests may edit their input builders while production DTOs retain readonly types. */
export type MutableFixture<T> = T extends
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  ? T
  : T extends object
    ? { -readonly [Key in keyof T]: MutableFixture<T[Key]> }
    : T;
