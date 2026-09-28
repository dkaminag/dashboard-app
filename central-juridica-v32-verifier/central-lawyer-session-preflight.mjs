import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const RELEASE = "d507a9955be07ef710d410b5263686ac75caeeff";
const TARGET_DB = "central_juridica_v32_prod_r3";
const enabled = String(process.env.CJ_LAWYER_SESSION_PREFLIGHT || "").trim() === "true";
const nonce = String(process.env.CJ_LAWYER_SESSION_PREFLIGHT_NONCE || "").trim();

if (!enabled) {
  console.log(JSON.stringify({ event: "LAWYER_SESSION_PREFLIGHT_SKIPPED", enabled: false }));
  process.exit(0);
}

if (!/^[A-Za-z0-9._:-]{12,120}$/.test(nonce)) {
  throw new Error("LAWYER_SESSION_PREFLIGHT_NONCE_POLICY_FAILED");
}

const databaseBase = String(process.env.CJ_ADMIN_RESYNC_DATABASE_URL || "").trim();
const pgSsl = String(process.env.CJ_ADMIN_RESYNC_PG_SSL || "").trim() === "true";
if (!databaseBase) throw new Error("LAWYER_SESSION_PREFLIGHT_DATABASE_REFERENCE_MISSING");

function exec(cmd, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(cmd + "_FAILED_" + code)));
  });
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "cj-lawyer-session-preflight-"));
try {
  const archive = path.join(root, "source.tgz");
  const response = await fetch("https://codeload.github.com/dkaminag/dashboard-app/tar.gz/" + RELEASE);
  if (!response.ok) throw new Error("RELEASE_FETCH_" + response.status);
  await fs.writeFile(archive, Buffer.from(await response.arrayBuffer()));

  const src = path.join(root, "src");
  await fs.mkdir(src);
  await exec("tar", ["-xzf", archive, "-C", src, "--strip-components=1"], root);

  const candidate = path.join(src, "central-juridica-railway-v3.2.0");
  await exec(process.execPath, ["unpack.mjs"], candidate);
  await exec(process.execPath, ["apply-overlay.mjs"], candidate);
  await exec(process.execPath, ["patch-snapshot-dr.mjs"], candidate);
  await exec(process.execPath, ["patch-access-ui.mjs"], candidate);
  await exec("npm", ["install", "--prefix", "runtime", "--omit=dev", "--no-audit", "--no-fund"], candidate);

  const require = createRequire(path.join(candidate, "runtime", "package.json"));
  const { Pool } = require("pg");

  const dbUrl = new URL(databaseBase);
  dbUrl.pathname = "/" + TARGET_DB;
  if (pgSsl) dbUrl.searchParams.set("sslmode", "verify-full");

  const pool = new Pool({
    connectionString: dbUrl.toString(),
    max: 1,
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000,
    application_name: "central-juridica-lawyer-session-preflight",
    ssl: pgSsl ? { rejectUnauthorized: true } : undefined,
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");

    const users = await client.query(
      `SELECT count(*)::int AS count
       FROM central_juridica_users
       WHERE payload->>'role'='lawyer'
         AND payload->>'active'='true'`,
    );

    const sessions = await client.query(
      `SELECT count(*)::int AS count
       FROM central_juridica_sessions s
       JOIN central_juridica_users u ON u.user_id=s.user_id
       WHERE u.payload->>'role'='lawyer'
         AND u.payload->>'active'='true'`,
    );

    const activeLawyerUsers = Number(users.rows?.[0]?.count || 0);
    const lawyerSessionRows = Number(sessions.rows?.[0]?.count || 0);
    const serverJoinableLawyerSession = lawyerSessionRows > 0;

    await client.query("COMMIT");

    console.log(JSON.stringify({
      event: "LAWYER_SESSION_PREFLIGHT_COMPLETE",
      passed: activeLawyerUsers > 0 && serverJoinableLawyerSession,
      database: TARGET_DB,
      activeLawyerUsers,
      lawyerSessionRows,
      serverJoinableLawyerSession,
      rawUserIdentityEmitted: false,
      rawSessionMaterialEmitted: false,
      databaseCredentialEmitted: false,
      mutationPerformed: false,
      nonce,
    }));

    if (activeLawyerUsers < 1) throw new Error("LAWYER_SESSION_PREFLIGHT_NO_ACTIVE_LAWYER");
    if (!serverJoinableLawyerSession) throw new Error("LAWYER_SESSION_PREFLIGHT_NO_JOINABLE_SESSION");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
