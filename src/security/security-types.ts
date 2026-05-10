export interface AuditLogRow {
  audit_id: number;
  company_id: number;
  table_name: string;
  record_id: number;
  operation: "INSERT" | "UPDATE" | "DELETE";
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  changed_by: number;
  changed_at: string;
  ip_address: string | null;
  user_agent: string | null;
  transaction_id: number | null;
  session_id: string | null;
}

export interface FiscalPeriodRow {
  fiscal_period_id: number;
  company_id: number;
  period_name: string;
  start_date: string;
  end_date: string;
  is_locked: boolean;
  is_year_closing: boolean;
  locked_by: number | null;
  locked_at: string | null;
  lock_reason: string | null;
}

export interface RoleRow {
  role_id: number;
  role_name: string;
  description: string | null;
  is_system: boolean;
}

export type RoleName =
  | "SUPER_ADMIN"
  | "OWNER"
  | "ACCOUNTANT"
  | "DATA_ENTRY"
  | "AUDITOR"
  | "INVENTORY_MGR";

export interface PermissionRow {
  permission_id: number;
  module: string;
  action: string;
}

export interface UserCompanyRoleRow {
  user_id: number;
  company_id: number;
  role_id: number;
  assigned_at: string;
  assigned_by: number | null;
}

// Module names for RBAC checks
export type ModuleName = "ACCOUNTS" | "INVENTORY" | "GST" | "REPORTS" | "ADMIN";

// Actions for RBAC checks
export type ActionName =
  | "CREATE"
  | "READ"
  | "UPDATE"
  | "DELETE"
  | "LOCK_PERIOD"
  | "UNLOCK_PERIOD"
  | "MANAGE_USERS"
  | "VIEW_AUDIT_LOG"
  | "EXPORT";

// Security context set at the start of each API request
export interface SecurityContext {
  companyId: number;
  userId: number;
  roleId?: number;
  roleName?: RoleName;
  ipAddress?: string;
  userAgent?: string;
  sessionId?: string;
}