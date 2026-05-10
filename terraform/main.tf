# ============================================================================
# GLM PRODUCTION INFRASTRUCTURE — Neon (PostgreSQL) + Upstash (Redis) + Vercel
# ============================================================================
# Vercel itself is fully managed — no Terraform needed for compute.
# This file provisions the DATA LAYER: Neon database + Upstash Redis.
#
# Providers: Neon (API) + Upstash (API) + Vercel (API)
# State:     Terraform Cloud (remote state, encrypted)
# ============================================================================

terraform {
  required_version = ">= 1.6"

  required_providers {
    neon = {
      source  = "kislerdm/neon"
      version = "~> 0.5"
    }
    upstash = {
      source  = "upstash/upstash"
      version = "~> 1.4"
    }
    vercel = {
      source  = "vercel/vercel"
      version = "~> 0.16"
    }
  }

  cloud {
    organization = "glm-saas"
    workspaces {
      name = "glm-production"
    }
  }
}

# ============================================================================
# VARIABLES
# ============================================================================

variable "neon_api_key"       { type = string; sensitive = true }
variable "upstash_api_key"    { type = string; sensitive = true }
variable "upstash_email"      { type = string; sensitive = true }
variable "vercel_api_token"   { type = string; sensitive = true }
variable "vercel_team_id"     { type = string }
variable "encryption_master_key" { type = string; sensitive = true }
variable "jwt_secret"            { type = string; sensitive = true }
variable "domain_name"        { default = "glm-saas.in" }
variable "environment"        { default = "production" }
variable "aws_region"         { default = "ap-south-1" }

# ============================================================================
# NEON — Serverless PostgreSQL
# ============================================================================

# --- Neon Project ---
resource "neon_project" "glm" {
  name = "glm-production"
  region_id = "aws-ap-south-1"

  history_retention_seconds = 604800          # 7 days PITR
  quota {
    active_time_seconds              = 0      # Unlimited (Scale plan)
    compute_time_seconds             = 0      # Unlimited
    written_data_bytes               = 0
    data_transfer_bytes              = 0
    logical_size_bytes              = 0
  }
}

# --- Main (Production) Branch ---
resource "neon_branch" "main" {
  project_id = neon_project.glm.id
  name       = "main"
  role_name  = neon_role.app.name
  database_name = "glm_ledger"

  lifecycle {
    prevent_destroy = true   # Never accidentally destroy production branch
  }
}

# --- Database inside the branch ---
resource "neon_database" "glm_ledger" {
  project_id = neon_project.glm.id
  branch_id  = neon_branch.main.id
  name       = "glm_ledger"
  owner_name = neon_role.app.name
}

# --- Application Database Role ---
resource "neon_role" "app" {
  project_id = neon_project.glm.id
  branch_id  = neon_branch.main.id
  name       = "glm_app"
}

# --- Primary Compute Endpoint (Writer) ---
resource "neon_endpoint" "primary" {
  project_id = neon_project.glm.id
  branch_id  = neon_branch.main.id
  type       = "read_write"

  autoscaling_limit_min_cu = 1
  autoscaling_limit_max_cu = 16

  pooler_enabled  = true
  pooler_mode     = "session"

  # Allowlist: Vercel's outbound IP ranges for ap-south-1
  # Vercel publishes these IPs — update periodically
  # ip_allow_list   = var.vercel_ip_ranges
}

# --- Read Replica Compute Endpoint 1 (Reports) ---
resource "neon_endpoint" "read_replica_reports" {
  project_id = neon_project.glm.id
  branch_id  = neon_branch.main.id
  type       = "read_only"

  autoscaling_limit_min_cu = 1
  autoscaling_limit_max_cu = 8

  pooler_enabled = true
  pooler_mode    = "session"
}

# --- Read Replica Compute Endpoint 2 (Dashboard) ---
resource "neon_endpoint" "read_replica_dashboard" {
  project_id = neon_project.glm.id
  branch_id  = neon_branch.main.id
  type       = "read_only"

  autoscaling_limit_min_cu = 1
  autoscaling_limit_max_cu = 8

  pooler_enabled = true
  pooler_mode    = "session"
}

# ============================================================================
# UPSTASH — Redis (Session Store + Cache + Rate Limiter)
# ============================================================================

# --- Redis Global Database ---
resource "upstash_redis_database" "glm_redis" {
  database_name = "glm-production"
  region        = "ap-south-1"
  type          = "global"   # Multi-region replication for global Vercel edge

  tls         = true                  # TLS 1.3 encryption in transit
  eviction    = true                  # Allow key eviction under memory pressure
  enable_auto_update_rest_api = true

  multizone   = true                  # Multi-AZ high availability
}

# --- Redis for Edge Rate Limiting (smaller, faster) ---
resource "upstash_redis_database" "glm_rate_limiter" {
  database_name = "glm-rate-limiter"
  region        = "global"            # Edge-optimized: nearest PoP responds
  type          = "global"

  tls         = true
  eviction    = true
  multizone   = true
}

# ============================================================================
# VERCEL — Project Configuration + Environment Variables
# ============================================================================

resource "vercel_project" "glm" {
  name      = "glm-backend"
  framework = "other"                 # Custom Node.js, not Next.js
  git_repository {
    type = "github"
    repo = "glm-saas/glm-backend"
  }

  build_command   = "npm run build"
  output_directory = ".vercel/output"
  install_command  = "npm ci"
  root_directory   = "."

  serverless_function_region = "bom1" # Mumbai — lowest latency for Indian users

  # Production domain
  domains = [
    {
      domain = "api.${var.domain_name}"
      git_branch = "main"
    }
  ]
}

# --- Vercel Project Environment Variables ---
# Values are marked SENSITIVE — stored encrypted in Terraform Cloud state

resource "vercel_project_environment_variables" "glm" {
  project_id = vercel_project.glm.id
  variables = [
    # --- Neon Database URLs ---
    {
      key    = "NEON_DATABASE_URL"
      value  = "postgresql://${neon_role.app.name}:${neon_role.app.password}@${neon_endpoint.primary.host}/glm_ledger?sslmode=require"
      target = ["production", "preview", "development"]
      type   = "encrypted"
    },
    {
      key    = "NEON_READ_REPLICA_URL"
      value  = "postgresql://${neon_role.app.name}:${neon_role.app.password}@${neon_endpoint.read_replica_reports.host}/glm_ledger?sslmode=require"
      target = ["production"]
      type   = "encrypted"
    },
    {
      key    = "NEON_POOLED_URL"
      value  = "postgresql://${neon_role.app.name}:${neon_role.app.password}@${neon_endpoint.primary.host}/glm_ledger?sslmode=require&pgbouncer=true"
      target = ["production", "preview", "development"]
      type   = "encrypted"
    },

    # --- Upstash Redis ---
    {
      key    = "UPSTASH_REDIS_URL"
      value  = upstash_redis_database.glm_redis.endpoint
      target = ["production", "preview", "development"]
      type   = "encrypted"
    },
    {
      key    = "UPSTASH_REDIS_TOKEN"
      value  = upstash_redis_database.glm_redis.rest_token
      target = ["production", "preview", "development"]
      type   = "encrypted"
    },
    {
      key    = "UPSTASH_RATE_LIMITER_URL"
      value  = upstash_redis_database.glm_rate_limiter.endpoint
      target = ["production", "preview", "development"]
      type   = "encrypted"
    },
    {
      key    = "UPSTASH_RATE_LIMITER_TOKEN"
      value  = upstash_redis_database.glm_rate_limiter.rest_token
      target = ["production", "preview", "development"]
      type   = "encrypted"
    },

    # --- Encryption ---
    {
      key    = "ENCRYPTION_MASTER_KEY"
      value  = var.encryption_master_key
      target = ["production", "preview", "development"]
      type   = "encrypted"
    },

    # --- JWT ---
    {
      key    = "JWT_SECRET"
      value  = var.jwt_secret
      target = ["production", "preview", "development"]
      type   = "encrypted"
    },

    # --- App Config ---
    {
      key    = "NODE_ENV"
      value  = "production"
      target = ["production"]
      type   = "plain"
    },
    {
      key    = "API_BASE_URL"
      value  = "https://api.${var.domain_name}"
      target = ["production"]
      type   = "plain"
    },
    {
      key    = "CORS_ORIGIN"
      value  = "https://app.${var.domain_name}"
      target = ["production"]
      type   = "plain"
    },
    {
      key    = "LOG_LEVEL"
      value  = "info"
      target = ["production"]
      type   = "plain"
    }
  ]
}

# ============================================================================
# OUTPUTS — consumed by CI/CD, monitoring, and team documentation
# ============================================================================

output "neon_project_id"                 { value = neon_project.glm.id }
output "neon_branch_main_id"             { value = neon_branch.main.id }
output "neon_primary_endpoint_host"      { value = neon_endpoint.primary.host }
output "neon_read_replica_reports_host"  { value = neon_endpoint.read_replica_reports.host }
output "neon_read_replica_dashboard_host"{ value = neon_endpoint.read_replica_dashboard.host }
output "upstash_redis_id"                { value = upstash_redis_database.glm_redis.database_id }
output "upstash_rate_limiter_id"         { value = upstash_redis_database.glm_rate_limiter.database_id }
output "vercel_project_id"               { value = vercel_project.glm.id }
output "vercel_domain"                   { value = "api.${var.domain_name}" }
