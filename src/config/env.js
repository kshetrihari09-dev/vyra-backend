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
  if (!["console", "disabled", "webhook"].includes(notifyDriver)) errors.push("NOTIFY_DRIVER must be console, disabled or webhook");
  // "webhook" hands each SMS/email to YOUR gateway as a signed HTTP POST (see services/notifier.js) — the provider-agnostic
  // way to reach a real SMS/email service without this codebase depending on any one vendor's SDK.
  const webhookUrl = env.NOTIFY_WEBHOOK_URL || "";
  const webhookSecret = env.NOTIFY_WEBHOOK_SECRET || "";
  if (notifyDriver === "webhook") {
    if (!webhookUrl) errors.push("NOTIFY_WEBHOOK_URL is required when NOTIFY_DRIVER=webhook");
    else if (!/^https?:\/\//.test(webhookUrl)) errors.push("NOTIFY_WEBHOOK_URL must be an http(s) URL");
    else if (isProd && !webhookUrl.startsWith("https://")) errors.push("NOTIFY_WEBHOOK_URL must be https in production (messages contain OTPs and reset links)");
    if (webhookSecret.length < 32) errors.push("NOTIFY_WEBHOOK_SECRET must be at least 32 characters when NOTIFY_DRIVER=webhook");
  }
  if (isProd && notifyDriver === "console") errors.push("NOTIFY_DRIVER=console would log OTPs and reset tokens; not allowed in production");

  // ---- Pharmacist support contact details. Optional: a missing value DISABLES that contact method in the UI (never a demo fallback).
  const phoneRaw = (env.PHARMACY_PHONE || "").trim();
  const phoneDigits = phoneRaw.replace(/[\s().-]/g, "");
  if (phoneRaw && !/^\+?[0-9]{7,15}$/.test(phoneDigits)) errors.push("PHARMACY_PHONE must be a phone number such as +9779812345678 (7-15 digits, optional leading +)");
  const emailOrNull = (name) => {
    const v = (env[name] || "").trim().toLowerCase();
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) errors.push(`${name} must be an email address`);
    return v || null;
  };
  const pharmacyEmail = emailOrNull("PHARMACY_SUPPORT_EMAIL");
  const generalEmail = emailOrNull("GENERAL_SUPPORT_EMAIL");

  // ---- Vyra Call (WebRTC voice calls, customer <-> Vyra Shop). STUN is public; TURN uses time-limited credentials derived
  // from CALLS_TURN_SECRET (coturn `use-auth-secret`), so no long-lived TURN password ever reaches a browser.
  const urlList = (name, schemes) => {
    const list = (env[name] || "").split(",").map((x) => x.trim()).filter(Boolean);
    for (const u of list) if (!new RegExp(`^(${schemes.join("|")}):[^\\s]+$`).test(u)) errors.push(`${name} entries must start with ${schemes.join(": or ")}: (got "${u}")`);
    return list;
  };
  const stunUrls = urlList("CALLS_STUN_URLS", ["stun", "stuns"]);
  const turnUrls = urlList("CALLS_TURN_URLS", ["turn", "turns"]);
  const turnSecret = env.CALLS_TURN_SECRET || "";
  if (turnUrls.length && turnSecret.length < 32) errors.push("CALLS_TURN_SECRET must be at least 32 characters when CALLS_TURN_URLS is set");
  if (turnSecret && !turnUrls.length) errors.push("CALLS_TURN_SECRET is set but CALLS_TURN_URLS is empty");
  const callsAllowStunOnly = bool(env.CALLS_ALLOW_STUN_ONLY, false);
  // Cross-network audio is unreliable without a relay, so in production calling stays OFF (and says so) until TURN is configured.
  const callsRequested = bool(env.CALLS_ENABLED, true);
  const callsDisabledReason = !callsRequested ? "disabled_by_config"
    : (isProd && !turnUrls.length && !callsAllowStunOnly) ? "turn_not_configured" : null;

  const otpDevCode = env.OTP_DEV_CODE || "";
  if (otpDevCode && !/^\d{4}$/.test(otpDevCode)) errors.push("OTP_DEV_CODE must be exactly 4 digits");
  if (isProd && otpDevCode) errors.push("OTP_DEV_CODE must not be set in production");

  const config = {
    nodeEnv, isProd, isTest: nodeEnv === "test",
    port: int("PORT", 4000, { min: 1 }),
    logLevel: env.LOG_LEVEL || "info",
    // Server-side routing (ETA). Optional: without it ETAs fall back to a labelled straight-line estimate. NEVER the browser's public token.
    maps: { accessToken: env.MAPBOX_ACCESS_TOKEN || "" },
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
    support: {
      pharmacyPhone: phoneRaw ? { display: phoneRaw, tel: phoneDigits } : null,
      pharmacyEmail, generalEmail,
      // A pharmacist is "online" for this long after the last heartbeat from their console (it beats every minute while open).
      presenceTtlSeconds: int("PHARMACIST_PRESENCE_TTL_SECONDS", 180, { min: 30 }),
    },
    calls: {
      enabled: callsDisabledReason === null,
      disabledReason: callsDisabledReason,
      ringSeconds: int("CALLS_RING_SECONDS", 45, { min: 15 }),            // how long a shop's phone "rings" before the call is marked missed
      connectSeconds: int("CALLS_CONNECT_SECONDS", 45, { min: 15 }),      // accepted -> audio connected, else the call fails
      maxMinutes: int("CALLS_MAX_MINUTES", 60, { min: 1 }),               // hard cap on one call
      peerTimeoutSeconds: int("CALLS_PEER_TIMEOUT_SECONDS", 45, { min: 20 }), // no liveness ping from a side for this long ends the call
      shopPresenceTtlSeconds: int("CALLS_SHOP_PRESENCE_TTL_SECONDS", 60, { min: 30 }),
      stunUrls: stunUrls.length ? stunUrls : (isProd ? [] : ["stun:stun.l.google.com:19302"]),
      turnUrls, turnSecret, turnTtlSeconds: int("CALLS_TURN_TTL_SECONDS", 3600, { min: 300 }),
      allowStunOnly: callsAllowStunOnly,
    },
    notify: { driver: notifyDriver, webhookUrl, webhookSecret, timeoutMs: int("NOTIFY_TIMEOUT_MS", 8000, { min: 500 }) },
    /* Background jobs (outbox worker, retention). Off in tests; safe to run in several processes (rows are claimed with SKIP LOCKED). */
    jobs: { enabled: bool(env.JOBS_ENABLED, nodeEnv !== "test") },
    /* Rate limiting can only be switched off outside production (tests / local debugging). */
    rateLimit: { enabled: isProd ? true : !bool(env.DISABLE_RATE_LIMIT, false) },
    storage: {
      bucket: env.STORAGE_BUCKET || null, region: env.STORAGE_REGION || null, endpoint: env.STORAGE_ENDPOINT || null,
      accessKey: env.STORAGE_ACCESS_KEY || null, secretKey: env.STORAGE_SECRET_KEY || null,
    },
    payments: {
      // Verifies inbound webhooks from the "manual" provider (see services/payments/manual.provider.js).
      // Real gateways (eSewa/Khalti/card) will each bring their own secret when they're wired in.
      manualWebhookSecret: env.PAYMENTS_MANUAL_WEBHOOK_SECRET || null,
    },
  };
  if (isProd && !env.PAYMENTS_MANUAL_WEBHOOK_SECRET) errors.push("PAYMENTS_MANUAL_WEBHOOK_SECRET is required in production (verifies payment webhooks)");

  // Encrypts seller settlement (bank/wallet) account numbers at rest — decision D8. Required everywhere, not
  // just production: there's no safe default for a key that decrypts real bank details.
  const dataEncryptionKey = req("DATA_ENCRYPTION_KEY");
  if (dataEncryptionKey) {
    let decodedLength = -1;
    try { decodedLength = Buffer.from(dataEncryptionKey, "base64").length; } catch { /* falls through to the error below */ }
    if (decodedLength !== 32) errors.push("DATA_ENCRYPTION_KEY must be base64 for exactly 32 bytes (e.g. node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\")");
  }
  config.security = { dataEncryptionKey };

  if (errors.length) {
    const err = new Error(`Invalid configuration:\n  - ${errors.join("\n  - ")}`);
    err.name = "ConfigError";
    throw err;
  }
  return config;
}
