// ============================================================================
// ANALYTICS MODULE — Barrel exports
// ============================================================================

export { AnalyticsService } from "./analytics-service";
export { AnalyticsCache, analyticsCache, determineAffectedReports } from "./analytics-cache";
export type { AccountClassification as CacheAccountClassification } from "./analytics-cache";
export {
  AnalyticsEventType,
} from "./analytics-types";
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
} from "./analytics-types";