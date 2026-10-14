import type { z } from "zod";

/** An error with the HTTP status to answer with. Its message is meant for the client. */
export class HttpError extends Error {
  override name = "HttpError";
  readonly statusCode: number;

  constructor(statusCode: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.statusCode = statusCode;
  }
}

/** Parses request input with `schema`, or fails with a 400 that lists every problem. */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const problems = result.error.issues.map((issue) =>
      issue.path.length > 0
        ? `${issue.path.map(String).join(".")}: ${issue.message}`
        : issue.message,
    );
    throw new HttpError(400, problems.join("; "));
  }
  return result.data;
}
