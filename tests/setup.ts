import { vi } from "vitest";

// ---------------------------------------------------------------------------
// VITEST GLOBAL SETUP
// ---------------------------------------------------------------------------

// Mock environment variables for tests
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-minimum-32-characters-long";
process.env.ENCRYPTION_MASTER_KEY = "test-encryption-master-key-32-char";
process.env.DB_HOST = "localhost";
process.env.DB_PORT = "5432";
process.env.DB_NAME = "glm_ledger_test";
process.env.DB_USER = "glm_test";
process.env.DB_PASSWORD = "test_password";

// Silence Pino in tests (unless debugging)
vi.mock("../src/config/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => vi.mocked({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  },
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => vi.mocked({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  },
  createChildLogger: vi.fn(() => vi.mocked({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

// Global test timeout
vi.setConfig({ testTimeout: 10000 });
