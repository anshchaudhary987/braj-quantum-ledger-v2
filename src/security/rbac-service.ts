import { PoolClient } from "pg";
import { ModuleName, ActionName, SecurityContext } from "./security-types.js";

// ---------------------------------------------------------------------------
// RBAC SERVICE — Authorization checks + security context setup
// ---------------------------------------------------------------------------

export class RbacService {
  private permissionCache: Map<string, Set<string>> | null = null;

  constructor(
    private readonly client: PoolClient,
    private readonly context: SecurityContext
  ) {}

  /**
   * Initialize the database session with RLS context.
   * MUST be called at the start of every API request BEFORE any business queries.
   */
  async initSecurityContext(): Promise<void> {
    await this.client.query(
      `SELECT init_security_context($1, $2, $3, $4)`,
      [
        this.context.companyId,
        this.context.userId,
        this.context.ipAddress ?? null,
        this.context.userAgent ?? null,
      ]
    );
  }

  /**
   * Check if the current user has a specific permission.
   * Uses the database function `user_has_permission` for accuracy.
   */
  async hasPermission(module: ModuleName, action: ActionName): Promise<boolean> {
    const { rows } = await this.client.query<{ has_perm: boolean }>(
      `SELECT user_has_permission($1, $2, $3, $4) AS has_perm`,
      [this.context.userId, this.context.companyId, module, action]
    );
    return rows[0]?.has_perm ?? false;
  }

  /**
   * Assert permission — throws if not authorized. Use as a guard in API routes.
   */
  async requirePermission(module: ModuleName, action: ActionName): Promise<void> {
    const allowed = await this.hasPermission(module, action);
    if (!allowed) {
      throw new Error(
        `Access denied: user ${this.context.userId} lacks permission ` +
        `${action} on ${module} for company ${this.context.companyId}`
      );
    }
  }

  /**
   * Fetch all permissions for the current user (useful for UI feature flags).
   */
  async getUserPermissions(): Promise<Array<{ module: string; action: string }>> {
    const { rows } = await this.client.query<{ module: string; action: string }>(
      `SELECT p.module, p.action
       FROM user_company_roles ucr
       JOIN role_permissions rp ON rp.role_id = ucr.role_id
       JOIN permissions p      ON p.permission_id = rp.permission_id
       WHERE ucr.user_id    = $1
         AND ucr.company_id = $2
       ORDER BY p.module, p.action`,
      [this.context.userId, this.context.companyId]
    );
    return rows;
  }

  /**
   * Assign a role to a user for a company.
   */
  async assignRole(
    targetUserId: number,
    roleName: string,
    assignedBy: number
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO user_company_roles (user_id, company_id, role_id, assigned_by)
       SELECT $1, $2, role_id, $4
       FROM roles WHERE role_name = $3
       ON CONFLICT (user_id, company_id, role_id) DO NOTHING`,
      [targetUserId, this.context.companyId, roleName, assignedBy]
    );
  }

  /**
   * Remove a role from a user.
   */
  async revokeRole(targetUserId: number, roleName: string): Promise<void> {
    await this.client.query(
      `DELETE FROM user_company_roles
       WHERE user_id    = $1
         AND company_id = $2
         AND role_id    = (SELECT role_id FROM roles WHERE role_name = $3)`,
      [targetUserId, this.context.companyId, roleName]
    );
  }

  /**
   * Get all roles for a user (useful for multi-role users).
   */
  async getUserRoles(userId?: number): Promise<Array<{ role_name: string; description: string | null }>> {
    const uid = userId ?? this.context.userId;
    const { rows } = await this.client.query<{ role_name: string; description: string | null }>(
      `SELECT r.role_name, r.description
       FROM user_company_roles ucr
       JOIN roles r ON r.role_id = ucr.role_id
       WHERE ucr.user_id    = $1
         AND ucr.company_id = $2`,
      [uid, this.context.companyId]
    );
    return rows;
  }
}
