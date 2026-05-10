import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import { readFileSync } from "node:fs";
import { errorHandler, notFoundHandler } from "./middleware/error-handler";
import { globalRateLimiter } from "./middleware/rate-limiter-redis";
import authRoutes from "./routes/auth.routes";
import voucherRoutes from "./routes/voucher.routes";
import einvoiceRoutes from "./routes/einvoice.routes";
import payrollRoutes from "./routes/payroll.routes";
import ocrRoutes from "./routes/ocr.routes";
import tallyImportRoutes from "./routes/tally-import.routes";
import healthRouter from "./routes/health.routes";
import { logger } from "../config/logger";

// ---------------------------------------------------------------------------
// EXPRESS APPLICATION SETUP
// ---------------------------------------------------------------------------

const app = express();

// ---- Security headers ----
app.use(helmet());

// ---- CORS — restrict to your frontend origins in production ----
app.use(
  cors({
    origin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
    credentials: true,
    maxAge: 86400,
  })
);

// ---- Compression — reduce response payload size ----
app.use(compression());

// ---- Body parsing ----
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ---- Trust proxy — required if behind nginx/ALB for correct IP logging ----
app.set("trust proxy", 1);

// ---- Global rate limiter ----
app.use(globalRateLimiter);

// ---- Request logging (uses Pino for structured JSON output) ----
app.use((req, _res, next) => {
  const start = Date.now();
  _res.on("finish", () => {
    logger.info({
      method: req.method,
      path: req.path,
      status: _res.statusCode,
      duration_ms: Date.now() - start,
      ip: req.ip,
      user_id: req.userId,
      company_id: req.companyId,
    }, "HTTP request completed");
  });
  next();
});

// ---- Health check (basic — detailed health at /api/v1/health) ----
app.get("/health", (_req, res) => {
  res.json({ 
    status: "ok", 
    timestamp: new Date().toISOString(),
    env: {
      DATABASE_URL: !!process.env.DATABASE_URL,
      NEON_DATABASE_URL: !!process.env.NEON_DATABASE_URL,
      JWT_SECRET: !!process.env.JWT_SECRET,
      NODE_ENV: process.env.NODE_ENV
    }
  });
});

// ---- API Routes ----
app.use("/api/v1/health", healthRouter);
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/vouchers", voucherRoutes);
app.use("/api/v1/einvoice", einvoiceRoutes);
app.use("/api/v1/payroll", payrollRoutes);
app.use("/api/v1/ocr", ocrRoutes);
app.use("/api/v1/tally-import", tallyImportRoutes);

// ---- API Documentation (Swagger UI) ----
// In production, serve the OpenAPI spec via a dedicated route.
let openApiSpec = "";
try {
  openApiSpec = readFileSync(new URL("./openapi.yaml", import.meta.url), "utf8");
} catch (err) {
  console.warn("Warning: Could not load openapi.yaml", err);
}

app.get("/api/v1/docs/openapi.yaml", (_req, res) => {
  if (!openApiSpec) return res.status(404).send("OpenAPI spec not found");
  res.type("application/yaml").send(openApiSpec);
});

app.get("/api/v1/docs/openapi.json", (_req, res) => {
  if (!openApiSpec) return res.status(404).send("OpenAPI spec not found");
  res.type("application/yaml").send(openApiSpec);
});

// ---- Error handling ----
app.use(notFoundHandler);
app.use(errorHandler);

// ---- Start server ----
const PORT = Number(process.env.PORT) || 3000;

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    logger.info(`GLM API server started on port ${PORT}`);
  });
}

export default app;
