import crypto from "crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { PoolClient } from "pg";
import {
  LoginRequest,
  LoginResponse,
  RefreshRequest,
  RefreshResponse,
  RegisterRequest,
  RegisterResponse,
  JwtPayload,
  UserProfile,
  CompanyBrief,
} from "../types.js";
import { ErrorCode } from "../errors.js";

// ---------------------------------------------------------------------------
// AUTH SERVICE — JWT + Refresh Token Rotation
// ---------------------------------------------------------------------------

const ACCESS_TOKEN_TTL  = 15 * 60;          // 15 minutes
const REFRESH_TOKEN_TTL = 7 * 24 * 60 * 60; // 7 days

type UnsignedJwtPayload = Omit<JwtPayload, "iat" | "exp">;

// Lazy-initialized JWT_SECRET to prevent crash at module import time on serverless
let _jwtSecret: string | null = null;

function getJwtSecret(): string {
  if (!_jwtSecret) {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) {
      throw new Error(
        "JWT_SECRET environment variable is required and must be at least 32 characters long. " +
        "Generate a secure secret with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
      );
    }
    _jwtSecret = secret;
  }
  return _jwtSecret;
}

export class AuthService {
  constructor(
    private readonly client: PoolClient,
    private readonly ipAddress?: string,
    private readonly userAgent?: string
  ) {}

  // -----------------------------------------------------------------------
  // REGISTER — Create new user and company
  // -----------------------------------------------------------------------
  async register(input: RegisterRequest): Promise<RegisterResponse> {
    // 1. Check if user already exists
    const { rows: existingUsers } = await this.client.query(
      "SELECT user_id FROM users WHERE email = $1",
      [input.email]
    );

    if (existingUsers.length > 0) {
      throw new AppError(ErrorCode.CONFLICT, "User with this email already exists.");
    }

    // 2. Hash password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(input.password, saltRounds);

    // 3. Create Company
    const { rows: companyRows } = await this.client.query<{ company_id: string }>(
      `INSERT INTO companies (company_name, company_type, registration_no)
       VALUES ($1, $2, $3)
       RETURNING company_id`,
      [input.company_name, input.company_type || "PROPRIETORSHIP", input.registration_no || null]
    );

    const companyId = parseInt(companyRows[0].company_id);

    // 4. Create User
    const { rows: userRows } = await this.client.query<{ user_id: string }>(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, $2, $3)
       RETURNING user_id`,
      [input.email, passwordHash, input.name]
    );

    const userId = parseInt(userRows[0].user_id);

    // 5. Assign OWNER role to user for this company
    await this.client.query(
      `INSERT INTO user_company_roles (user_id, company_id, role_id)
       VALUES ($1, $2, (SELECT role_id FROM roles WHERE role_name = 'OWNER' LIMIT 1))` ,
      [userId, companyId]
    );

    // 6. Automatically log the user in and return tokens
    const loginResult = await this.login({
      email: input.email,
      password: input.password,
      company_id: companyId
    });

    return {
      message: "Registration successful.",
      user_id: userId,
      company_id: companyId,
      ...loginResult
    };
  }

  // -----------------------------------------------------------------------
  // LOGIN — Verify credentials, issue token pair
  // -----------------------------------------------------------------------
  async login(input: LoginRequest): Promise<LoginResponse> {
    // 1. Verify credentials (simplified — use bcrypt in production)
    const { rows: userRows } = await this.client.query<{
      user_id: number; email: string; name: string;
      password_hash: string;
    }>(
      `SELECT user_id, email, name, password_hash
       FROM users WHERE email = $1 AND is_active = TRUE`,
      [input.email]
    );

    if (userRows.length === 0) {
      throw new AppError(ErrorCode.INVALID_CREDENTIALS, "Invalid email or password.");
    }

    const user = userRows[0];

    // Verify password using bcrypt (configured in production)
    if (!user.password_hash) {
      throw new AppError(ErrorCode.INVALID_CREDENTIALS, "Invalid email or password.");
    }
    const valid = await bcrypt.compare(input.password, user.password_hash);
    if (!valid) {
      throw new AppError(ErrorCode.INVALID_CREDENTIALS, "Invalid email or password.");
    }

    // 2. Get companies this user belongs to
    const { rows: companyRows } = await this.client.query<CompanyBrief>(
      `SELECT c.company_id, c.company_name, gr.gstin
       FROM companies c
       JOIN user_company_roles ucr ON ucr.company_id = c.company_id
       LEFT JOIN gst_registrations gr ON gr.company_id = c.company_id
       WHERE ucr.user_id = $1`,
      [user.user_id]
    );

    if (companyRows.length === 0) {
      throw new AppError(ErrorCode.FORBIDDEN, "No company access. Contact administrator.");
    }

    // 3. Determine which company context to use
    const targetCompanyId = input.company_id ?? companyRows[0].company_id;
    const targetCompany = companyRows.find(c => c.company_id === targetCompanyId);
    if (!targetCompany) {
      throw new AppError(ErrorCode.FORBIDDEN, "User does not have access to this company.");
    }

    // 4. Get user roles for this company
    const { rows: roleRows } = await this.client.query<{ role_name: string }>(
      `SELECT r.role_name
       FROM user_company_roles ucr
       JOIN roles r ON r.role_id = ucr.role_id
       WHERE ucr.user_id = $1 AND ucr.company_id = $2`,
      [user.user_id, targetCompanyId]
    );

    const roles = roleRows.map(r => r.role_name);

    // 5. Generate token pair
    const userProfile: UserProfile = {
      user_id: user.user_id,
      email: user.email,
      name: user.name,
      current_company_id: targetCompanyId,
      current_company_name: targetCompany.company_name,
      roles,
    };

    const { accessToken, refreshToken } = await this.generateTokenPair(
      user.user_id, targetCompanyId, roles
    );

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: ACCESS_TOKEN_TTL,
      user: userProfile,
      companies: companyRows,
    };
  }

  // -----------------------------------------------------------------------
  // REFRESH — Rotate token pair (old refresh token invalidated)
  // -----------------------------------------------------------------------
  async refresh(input: RefreshRequest): Promise<RefreshResponse> {
    const tokenHash = this.hashToken(input.refresh_token);

    // 1. Look up the refresh token
    const { rows } = await this.client.query<{
      token_id: string;
      user_id: number;
      company_id: number;
      revoked_at: string | null;
      expires_at: string;
      token_family: string;
    }>(
      `SELECT token_id, user_id, company_id, revoked_at, expires_at, token_family
       FROM refresh_tokens
       WHERE token_hash = $1
       FOR UPDATE`,
      [tokenHash]
    );

    const stored = rows[0];
    if (!stored) {
      throw new AppError(ErrorCode.TOKEN_REVOKED, "Invalid refresh token.");
    }

    // 2. Check if already revoked (token family rotation — detects token theft)
    if (stored.revoked_at) {
      // Someone used an already-revoked token → possible token theft
      // Invalidate the ENTIRE token family
      await this.client.query(
        `UPDATE refresh_tokens SET revoked_at = now()
         WHERE token_family = $1 AND revoked_at IS NULL`,
        [stored.token_family]
      );
      throw new AppError(ErrorCode.TOKEN_REVOKED, "Token family revoked due to potential token theft.");
    }

    // 3. Check expiry
    if (new Date(stored.expires_at) < new Date()) {
      throw new AppError(ErrorCode.TOKEN_EXPIRED, "Refresh token has expired. Please login again.");
    }

    // 4. Revoke the old token (single use)
    await this.client.query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE token_id = $1`,
      [stored.token_id]
    );

    // 5. Get current roles
    const { rows: roleRows } = await this.client.query<{ role_name: string }>(
      `SELECT r.role_name
       FROM user_company_roles ucr
       JOIN roles r ON r.role_id = ucr.role_id
       WHERE ucr.user_id = $1 AND ucr.company_id = $2`,
      [stored.user_id, stored.company_id]
    );

    const roles = roleRows.map(r => r.role_name);

    // 6. Issue new token pair (within the same family for audit trail)
    const { accessToken, refreshToken } = await this.generateTokenPair(
      stored.user_id, stored.company_id, roles, stored.token_family
    );

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: ACCESS_TOKEN_TTL,
    };
  }

  // -----------------------------------------------------------------------
  // LOGOUT — Revoke the refresh token
  // -----------------------------------------------------------------------
  async logout(userId: number, companyId: number, refreshToken?: string): Promise<void> {
    if (refreshToken) {
      const tokenHash = this.hashToken(refreshToken);
      await this.client.query(
        `UPDATE refresh_tokens SET revoked_at = now()
         WHERE token_hash = $1 AND user_id = $2 AND company_id = $3`,
        [tokenHash, userId, companyId]
      );
    }
  }

  // -----------------------------------------------------------------------
  // VERIFY ACCESS TOKEN — used by middleware
  // -----------------------------------------------------------------------
  verifyAccessToken(token: string): JwtPayload {
    try {
      const decoded = jwt.verify(token, getJwtSecret());
      if (!this.isJwtPayload(decoded)) {
        throw new AppError(ErrorCode.UNAUTHORIZED, "Invalid access token.");
      }
      return decoded;
    } catch (err: any) {
      if (err.name === "TokenExpiredError") {
        throw new AppError(ErrorCode.TOKEN_EXPIRED, "Access token has expired.");
      }
      throw new AppError(ErrorCode.UNAUTHORIZED, "Invalid access token.");
    }
  }

  // -----------------------------------------------------------------
  // PRIVATE HELPERS
  // -----------------------------------------------------------------
  private async generateTokenPair(
    userId: number,
    companyId: number,
    roles: string[],
    existingFamily?: string
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const jti = crypto.randomUUID();
    const accessPayload: UnsignedJwtPayload = { sub: userId, cid: companyId, roles, jti };

    // Access token — short-lived, stateless
    const accessToken = jwt.sign(
      accessPayload,
      getJwtSecret(),
      { expiresIn: ACCESS_TOKEN_TTL }
    );

    // Refresh token — long-lived, stored in DB
    const refreshToken = crypto.randomBytes(48).toString("base64url");
    const tokenHash     = this.hashToken(refreshToken);
    const tokenFamily   = existingFamily ?? crypto.randomUUID();

    // Rotate: mark old token in same family as revoked
    if (existingFamily) {
      await this.client.query(
        `UPDATE refresh_tokens SET revoked_at = now()
         WHERE token_family = $1 AND revoked_at IS NULL AND token_hash != $2`,
        [tokenFamily, tokenHash]
      );
    }

    // Store the new refresh token
    await this.client.query(
      `INSERT INTO refresh_tokens
         (user_id, company_id, token_hash, token_family,
          ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '7 days')`,
      [userId, companyId, tokenHash, tokenFamily, this.ipAddress ?? null, this.userAgent ?? null]
    );

    return { accessToken, refreshToken };
  }

  private hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  private isJwtPayload(decoded: unknown): decoded is JwtPayload {
    if (!decoded || typeof decoded !== "object") return false;
    const payload = decoded as Record<string, unknown>;
    return typeof payload.sub === "number" &&
      typeof payload.cid === "number" &&
      Array.isArray(payload.roles) &&
      payload.roles.every((role) => typeof role === "string") &&
      typeof payload.iat === "number" &&
      typeof payload.exp === "number" &&
      typeof payload.jti === "string";
  }
}

// ---------------------------------------------------------------------------
// AppError — thrown from any layer, caught by the error handler middleware
// ---------------------------------------------------------------------------
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = code;
    this.statusCode = AppError.codeToStatus(code);
    this.details = details;
  }

  static codeToStatus(code: ErrorCode): number {
    switch (code) {
      case ErrorCode.UNAUTHORIZED:
      case ErrorCode.INVALID_CREDENTIALS:
      case ErrorCode.TOKEN_EXPIRED:
      case ErrorCode.TOKEN_REVOKED:
        return 401;
      case ErrorCode.FORBIDDEN:
      case ErrorCode.LEDGER_LOCKED:
      case ErrorCode.PERIOD_CLOSED:
        return 403;
      case ErrorCode.VALIDATION_ERROR:
      case ErrorCode.INVALID_GSTIN:
      case ErrorCode.INVALID_PLACE_OF_SUPPLY:
      case ErrorCode.INVALID_HSN_SAC:
      case ErrorCode.DOUBLE_ENTRY_VIOLATION:
      case ErrorCode.GST_RATE_NOT_FOUND:
      case ErrorCode.TAX_MISMATCH:
      case ErrorCode.BATCH_EXPIRED:
      case ErrorCode.INSUFFICIENT_STOCK:
        return 422;
      case ErrorCode.IDEMPOTENCY_CONFLICT:
      case ErrorCode.CONFLICT:
        return 409;
      case ErrorCode.NOT_FOUND:
      case ErrorCode.ACCOUNT_NOT_FOUND:
      case ErrorCode.TRANSACTION_NOT_FOUND:
      case ErrorCode.ITEM_NOT_FOUND:
      case ErrorCode.GODOWN_NOT_FOUND:
        return 404;
      case ErrorCode.RATE_LIMIT_EXCEEDED:
        return 429;
      default:
        return 500;
    }
  }
}
