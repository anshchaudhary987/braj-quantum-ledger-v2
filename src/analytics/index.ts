// ============================================================================
// ANALYTICS MODULE — Barrel exports
// ============================================================================

export { AnalyticsService } from "./analytics-service.js";
export { AnalyticsCache, analyticsCache, determineAffectedReports } from "./analytics-cache.js";
export type { AccountClassification as CacheAccountClassification } from "./analytics-cache.js";
export {
  AnalyticsEventType,
} from "./analytics-types.js";
export type {
  CashFlowLine,
  CashFlowReport,
  CashFlowSectionSummary,
  FinancialRatio,
  RatioReport,
  InventoryAgingLine,
  InventoryAgingSummary,
  InventoryAgingReport,
  ExecutiveDashboard,
  DashboardKeyMetrics,
  CacheConfig,
  CacheEnvelope,
  CacheState,
  InvalidationPayload,
  AccountClassification,
  ReportType,
} from "./analytics-types.js";
