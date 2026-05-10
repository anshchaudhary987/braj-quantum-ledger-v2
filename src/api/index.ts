export { AuthService, AppError } from "./auth/auth-service.js";
export { requireAuth, optionalAuth, requireRole, setSecurityContext } from "./auth/auth-middleware.js";
export { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
export { globalRateLimiter, authRateLimiter, voucherRateLimiter } from "./middleware/rate-limiter.js";
export { validate } from "./middleware/validate.js";
export { ErrorCode } from "./errors.js";
export type {
  ApiErrorResponse,
  ApiSuccessResponse,
  PaginatedResponse,
  PaginationParams,
} from "./errors.js";
export type {
  LoginRequest,
  LoginResponse,
  RefreshRequest,
  RefreshResponse,
  UserProfile,
  CompanyBrief,
  JwtPayload,
  SalesVoucherRequest,
  SalesVoucherResponse,
  SalesVoucherLineResponse,
} from "./types.js";
export { EinvoiceService, Inv01PayloadMapper, GspAuthService, DistanceService, RetryWorker } from "../einvoicing/index.js";
export type {
  EInvoiceDetailRow, EwayBillDetailRow, RetryQueueRow,
  Inv01Payload, EwayBillPayload,
  GenerateEinvoiceInput, GenerateEwayBillInput,
  CancelEinvoiceInput, CancelEwayBillInput,
  DistanceCalcResult, GspApiResponse,
} from "../einvoicing/index.js";
export { PayrollService, PayrollEngine } from "../payroll/index.js";
export type {
  EmployeeRow, SalaryStructureRow, PayPeriodRow, AttendanceLogRow,
  PayrollRunRow, PayrollRunDetailRow, EmployeePayrollResult, PayrollRunResult,
  CreateEmployeeInput, CreateSalaryStructureInput, CreatePayPeriodInput,
  MarkAttendanceInput, RunPayrollInput, ApprovePayrollInput, JournalSummary,
} from "../payroll/index.js";
export { DocumentService, AiExtractionPipeline } from "../ocr/index.js";
export type {
  UploadedDocumentRow, OcrExtractionResultRow, ExtractedInvoiceData,
  OcrPipelineResult, SmartMatchResult,
  UploadDocumentInput, StartExtractionInput,
  ApproveDraftVoucherInput, RejectVoucherInput, AmendExtractionInput,
  DocumentPreviewResponse, ExtractionReviewResponse,
} from "../ocr/index.js";
export { TallyImportEngine, TallyXmlParser, parseTallyDate, normalizeAccountName } from "../tally-import/index.js";
export type {
  TallyImportBatchRow, TallyMasterMappingRow,
  Phase1Result, Phase2Result, TallyImportResult, VerificationResult,
  StartTallyImportInput,
} from "../tally-import/index.js";
