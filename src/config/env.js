/**
 * Reads and validates environment variables once, at startup. The process
 * refuses to boot with a missing/weak secret rather than limping along.
 * Pure function of its input so tests can pass their own env object.
 */
const TRUE = new Set(["1", "true", "yes", "on"]);
const bool = (v, fallback = false) => (v === undefined || v === "" ? fallback : TRUE.has(String(v).toLowerCase()));

export function loadConfig(env = process.env) {
  const errors = [];
  const req = (name) => {
    const v = env[name];
    if (v === undefined || v === "") errors.push(`${name} is required (see .env.example)`);
    return v ?? "";
  };
  const int = (name, fallback, { min = 0 } = {}) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) { errors.push(`${name} must be an integer >= ${min}`); return fallback; }
    return n;
  };

  const nodeEnv = env.NODE_ENV || "development";
  if (!["development", "test", "production"].includes(nodeEnv)) errors.push("NODE_ENV must be development, test or production");
  const isProd = nodeEnv === "production";

  const jwtSecret = req("JWT_SECRET");
  const refreshSecret = req("JWT_REFRESH_SECRET");
  for (const [name, value] of [["JWT_SECRET", jwtSecret], ["JWT_REFRESH_SECRET", refreshSecret]]) {
    if (value && value.length < 32) errors.push(`${name} must be at least 32 characters`);
    if (value && /change[-_ ]?me/i.test(value)) errors.push(`${name} still contains a placeholder value`);
  }
  if (jwtSecret && jwtSecret === refreshSecret) errors.push("JWT_SECRET and JWT_REFRESH_SECRET must be different");

  const corsOrigins = (env.CORS_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (isProd && corsOrigins.length === 0) errors.push("CORS_ORIGIN is required in production");
  if (isProd && corsOrigins.includes("*")) errors.push("CORS_ORIGIN must not be * (credentials are used)");

  const notifyDriver = env.NOTIFY_DRIVER || (isProd ? "disabled" : "console");
  if (!["console", "disabled"].includes(notifyDriver)) errors.push("NOTIFY_DRIVER must be console or disabled");
  if (isProd && notifyDriver === "console") errors.push("NOTIFY_DRIVER=console would log OTPs and reset tokens; not allowed in production");

  const otpDevCode = env.OTP_DEV_CODE || "";
  if (otpDevCode && !/^\d{4}$/.test(otpDevCode)) errors.push("OTP_DEV_CODE must be exactly 4 digits");
  if (isProd && otpDevCode) errors.push("OTP_DEV_CODE must not be set in production");

  const config = {
    nodeEnv, isProd, isTest: nodeEnv === "test",
    port: int("PORT", 4000, { min: 1 }),
    logLevel: env.LOG_LEVEL || "info",
    trustProxy: int("TRUST_PROXY", 0),
    appUrl: (env.APP_URL || "http://localhost:5173").replace(/\/+$/, ""),
    cors: { origins: corsOrigins },
    db: {
      url: req("DATABASE_URL"),
      ssl: bool(env.DB_SSL),
      sslRejectUnauthorized: bool(env.DB_SSL_REJECT_UNAUTHORIZED, true),
      poolMax: int("DB_POOL_MAX", 10, { min: 1 }),
    },
    auth: {
      jwtSecret,
      refreshSecret,
      accessTtlSeconds: int("ACCESS_TOKEN_TTL_SECONDS", 900, { min: 60 }),
      refreshTtlDays: int("REFRESH_TOKEN_TTL_DAYS", 30, { min: 1 }),
      resetTtlMinutes: int("PASSWORD_RESET_TTL_MINUTES", 30, { min: 5 }),
      maxLoginFailures: int("LOGIN_MAX_FAILURES", 5, { min: 3 }),
      lockoutMinutes: int("LOGIN_LOCKOUT_MINUTES", 15, { min: 1 }),
      refreshRotationGraceSeconds: 10,
    },
    otp: {
      length: 4, // matches the existing 4-digit OtpStep UI
      ttlSeconds: int("OTP_TTL_SECONDS", 300, { min: 60 }),
      maxAttempts: 5,
      maxStartsPerMobilePerHour: 5,
      devCode: otpDevCode || null,
    },
    cookie: {
      name: "vyra_rt",
      secure: env.COOKIE_SECURE === undefined || env.COOKIE_SECURE === "" ? isProd : bool(env.COOKIE_SECURE),
      domain: env.COOKIE_DOMAIN || undefined,
    },
    notify: { driver: notifyDriver },
    /* Rate limiting can only be switched off outside production (tests / local debugging). */
    rateLimit: { enabled: isProd ? true : !bool(env.DISABLE_RATE_LIMIT, false) },
    storage: {
      bucket: env.STORAGE_BUCKET || null, region: env.STORAGE_REGION || null, endpoint: env.STORAGE_ENDPOINT || null,
      accessKey: env.STORAGE_ACCESS_KEY || null, secretKey: env.STORAGE_SECRET_KEY || null,
    },
  };

  if (errors.length) {
    const err = new Error(`Invalid configuration:\n  - ${errors.join("\n  - ")}`);
    err.name = "ConfigError";
    throw err;
  }
  return config;
}
