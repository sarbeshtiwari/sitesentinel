import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import type { ErrorEnvelope } from "@wim/contracts";
import { MembershipError } from "@wim/db";
import { createLogger } from "@wim/logger";
import { AppError, Errors } from "./errors.js";

const log = createLogger("api");

/** Central error handling: every error leaves the API in the documented envelope. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<FastifyRequest>();
    const reply = ctx.getResponse<FastifyReply>();
    const requestId = String(req.id);

    let status = 500;
    let body: ErrorEnvelope["error"] = { code: "INTERNAL", message: "Something went wrong", requestId };
    let headers: Record<string, string> | undefined;

    if (exception instanceof MembershipError) {
      exception = exception.reason === "not_member" ? Errors.notFound() : Errors.forbidden();
    }
    if (exception instanceof AppError) {
      status = exception.status;
      body = { code: exception.code, message: exception.message, details: exception.details, requestId };
      headers = exception.headers;
    } else if (exception instanceof ZodError) {
      status = 400;
      body = {
        code: "VALIDATION_FAILED",
        message: "Some fields are invalid",
        details: { issues: exception.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
        requestId,
      };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      body = {
        code: status === 404 ? "NOT_FOUND" : status === 400 ? "VALIDATION_FAILED" : status === 413 ? "VALIDATION_FAILED" : "INTERNAL",
        message: status === 404 ? "Not found" : exception.message,
        requestId,
      };
    } else if (isPrismaUniqueViolation(exception)) {
      status = 409;
      body = { code: "CONFLICT", message: "This conflicts with an existing record", requestId };
    } else {
      log.error({ err: exception, requestId, route: req.routeOptions?.url }, "unhandled error");
    }

    if (status >= 500 && !(exception instanceof AppError)) {
      body.message = "Something went wrong";
    }
    if (headers) for (const [k, v] of Object.entries(headers)) reply.header(k, v);
    reply.header("Cache-Control", "no-store");
    void reply.status(status).send({ error: body });
  }
}

export function isPrismaUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}
