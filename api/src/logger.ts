import { pino, type Logger } from "pino";

export type { Logger };

/** Structured JSON logs on stdout, one object per line. */
export function createLogger(): Logger {
  return pino({ timestamp: pino.stdTimeFunctions.isoTime });
}
