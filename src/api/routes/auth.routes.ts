import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { AuthService, AppError } from "../auth/auth-service.js";
import { validate } from "../middleware/validate.js";
import { authRateLimiter } from "../middleware/rate-limiter-redis.js";
import { withClient, withTransaction } from "../../db/pool.js";
import { requireAuth } from "../auth/auth-middleware.js";
import { LoginRequest, RefreshRequest, RegisterRequest } from "../types.js";
import { ErrorCode } from "../errors.js";

const router = Router();

// ---------------------------------------------------------------------------
// Schema definitions
// ---------------------------------------------------------------------------
const loginSchema = z.object({
  body: z.object({
    email: z.string().email("Invalid email format."),
    password: z.string().min(8, "Password must be at least 8 characters."),
    company_id: z.number().int().positive().optional(),
    device_info: z.string().max(500).optional(),
  }),
});

const registerSchema = z.object({
  body: z.object({
    email: z.string().email("Invalid email format."),
    password: z.string().min(8, "Password must be at least 8 characters."),
    name: z.string().min(2, "Name must be at least 2 characters."),
    company_name: z.string().min(2, "Company name must be at least 2 characters."),
    company_type: z.string().optional(),
    registration_no: z.string().optional(),
  }),
});

const refreshSchema = z.object({
  body: z.object({
    refresh_token: z.string().min(1, "Refresh token is required."),
  }),
});

// ---------------------------------------------------------------------------
// POST /api/v1/auth/register
// ---------------------------------------------------------------------------
router.post(
  "/register",
  authRateLimiter,
  validate(registerSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input: RegisterRequest = req.body;

      const result = await withClient(async (client) => {
        return withTransaction(client, async (tx) => {
          const service = new AuthService(tx, req.ip, req.headers["user-agent"] as string);
          return await service.register(input);
        });
      });

      res.status(201).json({
        data: result,
        meta: {
          timestamp: new Date().toISOString(),
          trace_id: req.traceId,
          version: "1.0",
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/v1/auth/login
// ---------------------------------------------------------------------------
router.post(
  "/login",
  authRateLimiter,
  validate(loginSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input: LoginRequest = req.body;

      const result = await withClient(async (client) => {
        const service = new AuthService(client, req.ip, req.headers["user-agent"] as string);
        return await service.login(input);
      });

      res.status(200).json({
        data: result,
        meta: {
          timestamp: new Date().toISOString(),
          trace_id: req.traceId,
          version: "1.0",
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/v1/auth/refresh
// ---------------------------------------------------------------------------
router.post(
  "/refresh",
  authRateLimiter,
  validate(refreshSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input: RefreshRequest = req.body;

      const result = await withClient(async (client) => {
        return withTransaction(client, async (tx) => {
          const service = new AuthService(tx, req.ip, req.headers["user-agent"] as string);
          return await service.refresh(input);
        });
      });

      res.status(200).json({
        data: result,
        meta: {
          timestamp: new Date().toISOString(),
          trace_id: req.traceId,
          version: "1.0",
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/v1/auth/logout
// ---------------------------------------------------------------------------
router.post(
  "/logout",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { refresh_token } = req.body;

      await withClient(async (client) => {
        const service = new AuthService(client);
        await service.logout(req.userId!, req.companyId!, refresh_token);
      });

      res.status(200).json({
        data: { message: "Logged out successfully." },
        meta: {
          timestamp: new Date().toISOString(),
          trace_id: req.traceId,
          version: "1.0",
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/auth/me — current user profile
// ---------------------------------------------------------------------------
router.get(
  "/me",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { rows } = await withClient(async (client) =>
        client.query<{ name: string; email: string }>(
          `SELECT name, email FROM users WHERE user_id = $1`,
          [req.userId!]
        )
      );

      res.status(200).json({
        data: {
          user_id: req.userId,
          company_id: req.companyId,
          roles: req.roles,
          ...rows[0],
        },
        meta: {
          timestamp: new Date().toISOString(),
          trace_id: req.traceId,
          version: "1.0",
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
