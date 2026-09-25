const LEGACY_STRICT_SSLMODES = new Set(["prefer", "require", "verify-ca"]);

export function normalizePostgresConnectionString(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) throw new Error("LEGAL_DATABASE_URL is required");

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("LEGAL_DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("LEGAL_DATABASE_URL must use postgres or postgresql");
  }

  const sslmode = String(url.searchParams.get("sslmode") || "").trim().toLowerCase();
  if (LEGACY_STRICT_SSLMODES.has(sslmode)) {
    // pg-connection-string 2.x currently treats these modes like verify-full but
    // warns that future libpq-compatible semantics will be weaker. Make the
    // current strict behavior explicit before that compatibility change lands.
    url.searchParams.set("sslmode", "verify-full");
  }

  return {
    connectionString: url.toString(),
    sslmode: String(url.searchParams.get("sslmode") || "").trim().toLowerCase(),
  };
}

export function buildPostgresPoolConfig(rawValue, sslFlagValue) {
  const normalized = normalizePostgresConnectionString(rawValue);
  const config = {
    connectionString: normalized.connectionString,
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };

  // A connection-string sslmode is authoritative in node-postgres and overrides
  // a sibling ssl object. Only apply the legacy LEGAL_PG_SSL fallback when the
  // URL carries no sslmode at all.
  if (!normalized.sslmode) {
    const flag = String(sslFlagValue || "").trim().toLowerCase();
    config.ssl = flag === "false" || flag === "0" ? false : { rejectUnauthorized: false };
  }

  return config;
}
