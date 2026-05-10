import { Request, Response, NextFunction } from "express";
import { AuthService } from "./auth-service.js";
import { runWithDbSecurityContext } from "../../db/pool.js";
import { JwtPayload } from "../types.js";
import { ErrorCode } from "../errors.js";
import { AppError } from "./auth-service.js";

// Extend Express Request to carry auth context
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
      companyId?: number;
      userId?: number;
      roles?: string[];
      traceId?: string;
    }
  }
}

const authService = new AuthService(null as any); // middleware-only; pool used separately

/**
 * REQUIRES AUTH — Decodes JWT, enriches request, sets DB security context.
 * Attach to every protected route.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next(new AppError(ErrorCode.UNAUTHORIZED, "Missing or invalid Authorization header."));
  }

  const token = authHeader.substring(7);

  try {
    const payload = authService.verifyAccessToken(token);

    req.user      = payload;
    req.userId    = payload.sub;
    req.companyId = payload.cid;
    req.roles     = payload.roles;

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * OPTIONAL AUTH — If a token is present, decode it. If absent, continue as anonymous.
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next();
  }

  const token = authHeader.substring(7);

  try {
    const payload = authService.verifyAccessToken(token);
    req.user      = payload;
    req.userId    = payload.sub;
    req.companyId = payload.cid;
    req.roles     = payload.roles;
  } catch {
    // Token invalid — continue without auth
  }

  next();
}

/**
 * REQUIRE ROLE — Place after requireAuth. Ensures the user has a specific role.
 */
export function requireRole(...allowedRoles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (allowedRoles.length === 0) {
      return next();
    }

    if (!req.roles || req.roles.length === 0) {
      return next(new AppError(ErrorCode.FORBIDDEN, "Access denied. No role assigned."));
    }

    const hasRole = req.roles.some(r => allowedRoles.includes(r));
    if (!hasRole) {
      return next(
        new AppError(
          ErrorCode.FORBIDDEN,
          `Access denied. Required roles: ${allowedRoles.join(", ")}.`
        )
      );
    }

    next();
  };
}

/**
 * SET DB SECURITY CONTEXT — Runs init_security_context() after auth is decoded.
 * Call this AFTER requireAuth in the middleware chain, or combine them.
 */
export async function setSecurityContext(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.companyId || !req.userId) {
    return next();
  }

  runWithDbSecurityContext(
    {
      companyId: req.companyId,
      userId: req.userId,
      ipAddress: req.ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    },
    next
  );
}
