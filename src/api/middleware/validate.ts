import { Request, Response, NextFunction } from "express";
import { ZodSchema, ZodError } from "zod";
import { ErrorCode } from "../errors";
import { AppError } from "../auth/auth-service";
import crypto from "crypto";

type RequestValidator =
  | ZodSchema
  | {
      body?: ZodSchema;
      query?: ZodSchema;
      params?: ZodSchema;
    };

function isZodSchema(value: RequestValidator): value is ZodSchema {
  return typeof (value as ZodSchema).parse === "function";
}

function safeTraceId(headerValue: unknown): string {
  if (typeof headerValue === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(headerValue)) {
    return headerValue;
  }

  return crypto.randomUUID();
}

/**
 * REQUEST VALIDATION MIDDLEWARE
 * Uses Zod schemas to validate body, query, and params.
 *
 * Attaches a trace_id to every request for error correlation.
 */
export function validate(validator: RequestValidator) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    // Attach trace ID early
    req.traceId = safeTraceId(req.headers["x-trace-id"]);
    _res.set("X-Trace-Id", req.traceId);

    try {
      if (isZodSchema(validator)) {
        const parsed = validator.parse({
          body: req.body,
          query: req.query,
          params: req.params,
        }) as { body?: unknown; query?: unknown; params?: unknown };

        if (Object.prototype.hasOwnProperty.call(parsed, "body")) {
          req.body = parsed.body;
        }
        if (Object.prototype.hasOwnProperty.call(parsed, "query")) {
          req.query = parsed.query as any;
        }
        if (Object.prototype.hasOwnProperty.call(parsed, "params")) {
          req.params = parsed.params as any;
        }
      } else {
        if (validator.body) {
          req.body = validator.body.parse(req.body);
        }
        if (validator.query) {
          req.query = validator.query.parse(req.query) as any;
        }
        if (validator.params) {
          req.params = validator.params.parse(req.params) as any;
        }
      }

      next();
    } catch (err) {
      if (err instanceof ZodError) {
        next(
          new AppError(
            ErrorCode.VALIDATION_ERROR,
            "Request validation failed.",
            { issues: err.issues }
          )
        );
      } else {
        next(err);
      }
    }
  };
}
