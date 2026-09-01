require("dotenv").config();

const express     = require("express");
const helmet      = require("helmet");
const cors        = require("cors");
const compression = require("compression");
const morgan      = require("morgan");
const rateLimit   = require("express-rate-limit");
const logger      = require("./utils/logger");

const { checkJwt, attachUser } = require("./middleware/auth");

// ─── APP ──────────────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 4000;

// ─── SECURITY MIDDLEWARE ──────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'"],
      imgSrc:     ["'self'", "data:"],
      connectSrc: ["'self'", `https://${process.env.AUTH0_DOMAIN}`],
    },
  },
  hsts: {
    maxAge:            63072000,  // 2 years
    includeSubDomains: true,
    preload:           true,
  },
}));

// CORS — only allow the configured frontend origins
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
  .split(",")
  .map(s => s.trim());

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials:      true,
  allowedHeaders:   ["Authorization","Content-Type","X-Correlation-ID"],
  exposedHeaders:   ["X-Request-ID"],
  maxAge:           86400,
}));

// ─── GENERAL MIDDLEWARE ───────────────────────────────────────────────────────
app.use(compression());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("combined", {
  stream: { write: (msg) => logger.info(msg.trim()) },
  skip:   (req) => req.url === "/health",
}));

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
// Global rate limit — 100 requests per IP per 15 minutes
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      100,
  message:  { error: "Too many requests — please slow down." },
  standardHeaders: true,
  legacyHeaders:   false,
}));

// Tighter limit for document uploads
const uploadLimit = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max:      10,
  message:  { error: "Upload limit reached — try again in an hour." },
});

// ─── HEALTH CHECK (no auth required) ─────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status:      "ok",
    service:     "on-my-way-api",
    region:      process.env.AWS_REGION || "us-west-2",
    environment: process.env.NODE_ENV,
    timestamp:   new Date().toISOString(),
    privacy_note: "GPS coordinates are never stored server-side.",
  });
});

// ─── AUTHENTICATED ROUTES ─────────────────────────────────────────────────────
// All routes below require a valid Auth0 JWT
app.use("/api", checkJwt, attachUser);

app.use("/api/users",            require("./routes/users"));
app.use("/api/trips",            require("./routes/trips"));
app.use("/api/verification",     require("./routes/verification"));
app.use("/api/law-enforcement",  require("./routes/lawEnforcement"));

// Upload routes get the tighter rate limit
app.use("/api/verification/upload", uploadLimit);

// ─── ERROR HANDLERS ───────────────────────────────────────────────────────────
// JWT errors (invalid/expired token)
app.use((err, req, res, next) => {
  if (err.name === "UnauthorizedError") {
    return res.status(401).json({ error: "Invalid or expired token. Please sign in again." });
  }
  next(err);
});

// CORS error
app.use((err, req, res, next) => {
  if (err.message?.startsWith("CORS")) {
    return res.status(403).json({ error: err.message });
  }
  next(err);
});

// Validation errors
app.use((err, req, res, next) => {
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request too large — max 1MB" });
  }
  next(err);
});

// Generic error handler — never expose stack traces in production
app.use((err, req, res, next) => {
  logger.error("Unhandled error", {
    error:   err.message,
    stack:   process.env.NODE_ENV !== "production" ? err.stack : undefined,
    path:    req.path,
    method:  req.method,
  });
  res.status(500).json({
    error: process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err.message,
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`On My Way API running`, {
    port:        PORT,
    environment: process.env.NODE_ENV,
    region:      process.env.AWS_REGION || "us-west-2",
    privacy:     "GPS coordinates never stored server-side (Washington MHMD compliant)",
  });

  // Start scheduled cleanup jobs
  require("./jobs/cleanup");
  logger.info("Auto-deletion jobs scheduled");
});

module.exports = app;
