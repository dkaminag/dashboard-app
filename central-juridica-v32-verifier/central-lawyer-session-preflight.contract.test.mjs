import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("./central-lawyer-session-preflight.mjs", import.meta.url), "utf8");

const required = [
  'CJ_LAWYER_SESSION_PREFLIGHT',
  'CJ_LAWYER_SESSION_PREFLIGHT_NONCE',
  'BEGIN READ ONLY',
  "payload->>'role'='lawyer'",
  "payload->>'active'='true'",
  'JOIN central_juridica_users u ON u.user_id=s.user_id',
  'rawUserIdentityEmitted: false',
  'rawSessionMaterialEmitted: false',
  'databaseCredentialEmitted: false',
  'mutationPerformed: false',
  'LAWYER_SESSION_PREFLIGHT_NO_ACTIVE_LAWYER',
  'LAWYER_SESSION_PREFLIGHT_NO_JOINABLE_SESSION',
];

for (const token of required) {
  assert.ok(source.includes(token), "missing_guard:" + token);
}

const forbiddenSql = [
  "INSERT INTO central_juridica_",
  "UPDATE central_juridica_",
  "DELETE FROM central_juridica_",
  "TRUNCATE ",
  "DROP TABLE",
  "ALTER TABLE",
  "CREATE TABLE",
];

for (const token of forbiddenSql) {
  assert.equal(source.includes(token), false, "mutation_sql_present:" + token);
}

const forbiddenLogs = [
  "username",
  "user_id:",
  "session_id:",
  "session_token",
  "passwordHash",
  "mfa",
  "totp",
];

for (const token of forbiddenLogs) {
  assert.equal(source.includes("console.log(" + token), false, "sensitive_log_pattern:" + token);
}

console.log("CENTRAL_LAWYER_SESSION_PREFLIGHT_CONTRACT=PASS");
