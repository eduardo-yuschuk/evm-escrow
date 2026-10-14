/** An error that retrying cannot fix: the process logs it and exits with a non-zero code. */
export class FatalError extends Error {
  override name = "FatalError";
}
