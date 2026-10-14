import { once } from "node:events";
import { STATUS_CODES } from "node:http";

import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

import type { ChainClient } from "../chain.js";
import type { ChainClock } from "../clock.js";
import type { Pool } from "../db/pool.js";
import type { Logger } from "../logger.js";
import { HttpError } from "./errors.js";
import { escrowRoutes } from "./escrows.js";
import { healthRoutes, type HealthOptions } from "./health.js";

/** One log line per request, when it completes. Health checks, frequent and boring, go at debug. */
class RequestLog extends LogController {
  override incomingRequest(): void {
    // Only the completion is logged.
  }

  override routeNotFound(): void {
    // Logged on completion, as a 404.
  }

  override requestCompleted(
    error: Error | null | undefined,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    const details = {
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      responseTime: reply.elapsedTime,
    };
    if (error) {
      reply.log.error({ ...details, err: error }, "request errored");
    } else {
      reply.log[request.routeOptions.url === "/health" ? "debug" : "info"](
        details,
        "request completed",
      );
    }
  }
}

/** HttpError carries its status; errors raised by fastify itself (e.g. a bad request) too. */
function statusOf(error: unknown): number {
  if (error instanceof HttpError) return error.statusCode;
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof statusCode === "number" && statusCode >= 400 && statusCode < 600 ? statusCode : 500;
}

export interface ServerDeps {
  pool: Pool;
  client: ChainClient;
  clock: ChainClock;
  log: Logger;
  health: HealthOptions;
}

/** The HTTP API, without listening: `serve` starts it, and tests can use `inject`. */
export function buildServer({ pool, client, clock, log, health }: ServerDeps): FastifyInstance {
  // Typed as fastify's logger interface, so the app is a plain FastifyInstance for the routes.
  const loggerInstance: FastifyBaseLogger = log;
  const app = Fastify({ loggerInstance, logController: new RequestLog() });

  // Errors keep fastify's shape: { statusCode, error, message }.
  app.setErrorHandler((error: unknown, request, reply) => {
    const statusCode = statusOf(error);
    if (statusCode >= 500) request.log.error({ err: error }, "request failed");
    // The message of an unexpected error may reveal internals: only intended ones are sent.
    const intended = error instanceof HttpError || statusCode < 500;
    const status = STATUS_CODES[statusCode] ?? "Error";
    return reply.code(statusCode).send({
      statusCode,
      error: status,
      message: intended && error instanceof Error ? error.message : status,
    });
  });

  escrowRoutes(app, { pool, clock });
  healthRoutes(app, { pool, client, options: health });
  return app;
}

/**
 * Serves `app` until `signal` aborts. Then it stops taking requests, answering 503 to new ones, and
 * waits for those in progress.
 */
export async function serve(
  app: FastifyInstance,
  { host, port }: { host: string; port: number },
  signal: AbortSignal,
): Promise<void> {
  try {
    await app.listen({ host, port });
    if (!signal.aborted) await once(signal, "abort");
  } finally {
    await app.close();
  }
}
