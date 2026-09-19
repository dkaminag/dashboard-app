import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStore } from './store-factory.mjs';
import { auditProcess, dashboardStats, newId, normalizeText, validateClient, validateProcess, validateTask } from './domain.mjs';
import { hasPermission, hashPassword, hashSessionToken, validateRole, verifyPassword, validateNewPassword } from './auth.mjs';
import { safeStorageName, validateDocumentInput } from './documents.mjs';
import { decryptBuffer, encryptBuffer, encryptedBufferKeyId, loadDocumentKeyring } from './crypto-storage.mjs';
import { GoogleWorkspaceClient } from './google-workspace.mjs';
import { GoogleTokenProvider } from './google-auth.mjs';
import { OpenAIResponsesClient } from './openai-client.mjs';
import { buildLegalDraftRequest, publicDraft, validateAiTask } from './ai-legal.mjs';
import { buildDailyBrief } from './triage.mjs';
import { executionAttention, validateAgreement, validateExecutionAction } from './legal-ops.mjs';
import { clientPortfolioCsv, clientPortfolioReport, processStatusReport } from './reporting.mjs';
import { filterFinancialEntries, financialSummary, validateFinancialEntry } from './finance.mjs';
import { evaluateAuditGates } from './audit-gates.mjs';
import { makeDefaultPreventiveItems, preventiveSummary, validateAssessment, validateItem } from './preventive.mjs';
import { evidenceQueueSummary, publicEvidence, validateEvidenceCandidate, validateEvidenceReview } from './external-evidence.mjs';
import { appendAuditEntry, initializeAuditChain, loadAuditKeyring, verifyAuditChain } from './audit-integrity.mjs';
import { consumeRecoveryCode, generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, isMfaRequired, loadMfaKeyring, makeOtpAuthUri, openMfaSecret, requiredMfaRoles, sealMfaSecret, verifyTotp } from './mfa.mjs';
import { publicKeyringStatus } from './keyring.mjs';
import { parseTrustedProxies, resolveClientIp } from './client-ip.mjs';
import { createRateLimiter, hashRateLimitKey, LOGIN_RATE_LIMIT } from './rate-limit.mjs';
import { loadBackupKeyring } from './backup.mjs';
import { evaluateRuntimeReadiness } from './runtime-readiness.mjs';
import { SAN_ALLOWED_ACTIONS, SAN_FORBIDDEN_ACTIONS, requireSanService, sanConfig } from './san-auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const packageInfo = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const appVersion = String(packageInfo.version || 'unknown');
const sanOpenApi = JSON.parse(await fs.readFile(path.join(root, 'contracts', 'central-juridica-san-v1.openapi.json'), 'utf8'));
const san = sanConfig();
const dataFile = process.env.CJ_DATA_FILE || path.join(root, 'data', 'db.json');
const documentDir = process.env.CJ_DOCUMENT_DIR || path.join(root, 'data', 'documents');
const documentStorageMode = String(process.env.CJ_DOCUMENT_STORAGE_MODE || 'local').trim().toLowerCase();
const documentsEnabled = documentStorageMode === 'local' || documentStorageMode === 'postgres';
const postgresDocumentStorage = documentStorageMode === 'postgres';
const port = Number(process.env.PORT || 8787);
const bootstrapUser = process.env.CJ_ADMIN_USER || 'admin';
const generatedPassword = crypto.randomBytes(14).toString('base64url');
const bootstrapPassword = process.env.CJ_ADMIN_PASSWORD || generatedPassword;
const bootstrapPasswordExplicit = Boolean(String(process.env.CJ_ADMIN_PASSWORD || '').trim());
const { store, backend, pool } = await createStore({ dataFile });
const trustedProxies = parseTrustedProxies();
const behindProxy = process.env.CJ_BEHIND_PROXY === 'true';
const rateLimiter = createRateLimiter({ pool });
const documentKeyring = loadDocumentKeyring();
const auditKeyring = loadAuditKeyring();
const mfaKeyring = loadMfaKeyring();
const backupKeyring = loadBackupKeyring();
if (process.env.CJ_ENV === 'production' && backend !== 'postgres') throw new Error('Modo production exige CJ_DATABASE_URL/PostgreSQL.');
if (process.env.CJ_ENV === 'production' && behindProxy && !trustedProxies.length) throw new Error('CJ_BEHIND_PROXY=true em production exige CJ_TRUST_PROXY explícito.');
if (process.env.CJ_ENV === 'production' && rateLimiter.backend !== 'postgres') throw new Error('Modo production exige rate limiter compartilhado em PostgreSQL.');
if (postgresDocumentStorage && backend !== 'postgres') throw new Error('CJ_DOCUMENT_STORAGE_MODE=postgres exige backend PostgreSQL.');
if (process.env.CJ_ENV === 'production' && documentsEnabled && !documentKeyring) throw new Error('Modo production com documentos habilitados exige CJ_DOCUMENT_KEY.');
if (process.env.CJ_ENV === 'production' && process.env.CJ_SECURE_COOKIE !== 'true') throw new Error('Modo production exige CJ_SECURE_COOKIE=true.');
await store.ensure();
await rateLimiter.ensure();
if (store.supportsDedicatedAudit) {
  const initialAudit = await store.readAuditState();
  const verification = verifyAuditChain(initialAudit, auditKeyring);
  if (!verification.ok) throw Object.assign(new Error('Auditoria PostgreSQL dedicada reprovada na inicialização.'), { verification });
} else {
  await store.mutate(state => initializeAuditChain(state, auditKeyring));
}
if (documentStorageMode === 'local') await fs.mkdir(documentDir, { recursive: true, mode: 0o700 });
if (process.env.CJ_ENV === 'production' && !bootstrapPasswordExplicit && !(await store.read()).users.length) throw new Error('Modo production com banco sem usuários exige CJ_ADMIN_PASSWORD explícita para bootstrap.');
const bootstrapCreated = await ensureBootstrapAdmin();
const googleEnabled = process.env.CJ_GOOGLE_ENABLED === 'true';
const aiEnabled = process.env.CJ_AI_ENABLED === 'true';
const googleTokenProvider = new GoogleTokenProvider();
const googleConfigured = googleEnabled && googleTokenProvider.configured;
const googleAuthMode = googleTokenProvider.mode;
const openaiConfigured = aiEnabled && Boolean(String(process.env.CJ_OPENAI_API_KEY || '').trim() && String(process.env.CJ_OPENAI_MODEL || '').trim());
if (process.env.CJ_ENV === 'production' && googleEnabled && !googleTokenProvider.refreshConfigured) throw new Error('Google habilitado em production exige client ID, client secret e refresh token; access token isolado não é aceito.');

const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon'
};

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (process.env.CJ_ENV === 'production' && process.env.CJ_SECURE_COOKIE === 'true') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function json(res, status, body, requestId) {
  securityHeaders(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (requestId) res.setHeader('X-Request-Id', requestId);
  res.end(JSON.stringify(body));
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1));
  }
  return out;
}

async function currentSession(req) {
  const token = parseCookies(req).cj_session;
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const record = await store.findSession(tokenHash);
  if (!record || Date.parse(record.expiresAt) <= Date.now()) {
    if (record) await store.revokeSession(tokenHash);
    return null;
  }
  const user = await store.findUserById(record.userId);
  if (user?.active === false) { await store.revokeSession(tokenHash); return null; }
  if (!user) { await store.revokeSession(tokenHash); return null; }
  return { tokenHash, user };
}

function requirePermission(session, permission) {
  if (!hasPermission(session?.user?.role, permission)) throw Object.assign(new Error('Acesso negado para este perfil.'), { status: 403 });
}

async function readBody(req, maxBytes = 15 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Payload muito grande.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('JSON inválido.'), { status: 400 }); }
}

function sameOriginAllowed(req) {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return true;
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin) return process.env.CJ_ENV !== 'production';
  if (!host) return false;
  return origin === `http://${host}` || origin === `https://${host}`;
}

async function idempotentCreate(req, keyPrefix, createFn) {
  const key = String(req.headers['idempotency-key'] || '').trim();
  if (!key) return createFn(null, null);
  if (key.length > 120) throw Object.assign(new Error('Idempotency-Key inválida.'), { status: 400 });
  if (store.supportsDedicatedIdempotency && typeof store.idempotentTransaction === 'function') {
    return store.idempotentTransaction(keyPrefix, key, tx => createFn(tx.state, tx));
  }
  return store.mutate(async db => {
    const fullKey = `${keyPrefix}:${key}`;
    if (db.idempotency[fullKey]) return { ...db.idempotency[fullKey], replayed: true };
    const result = await createFn(db, null);
    db.idempotency[fullKey] = result;
    const keys = Object.keys(db.idempotency);
    while (keys.length > 1000) delete db.idempotency[keys.shift()];
    return result;
  });
}


async function readAuditView() {
  return store.supportsDedicatedAudit ? store.readAuditState() : store.read();
}

function addAudit(db, session, requestId, action, entity, entityId, detail = {}) {
  return appendAuditEntry(db, {
    id: newId('audit'), action, entity, entityId, requestId,
    actor: session?.user ? { id: session.user.id, username: session.user.username, role: session.user.role } : null,
    detail, at: new Date().toISOString()
  }, auditKeyring);
}

async function ensureBootstrapAdmin() {
  const db = await store.read();
  if (db.users.length) return false;
  const bootstrapValidation = validateNewPassword(bootstrapPassword, { username: bootstrapUser });
  if (!bootstrapValidation.ok) throw new Error(`Senha bootstrap inválida: ${bootstrapValidation.error}`);
  const passwordHash = await hashPassword(bootstrapValidation.value);
  await store.mutate(state => {
    if (state.users.length) return;
    const now = new Date().toISOString();
    const user = { id: newId('usr'), username: bootstrapUser, name: 'Administrador', role: 'admin', passwordHash, active: true, createdAt: now, updatedAt: now };
    state.users.push(user);
    addAudit(state, null, 'bootstrap', 'BOOTSTRAP_ADMIN', 'user', user.id, { username: user.username });
  });
  return true;
}

function publicUser(user) {
  if (!user) return null;
  const { passwordHash, mfa, ...safe } = user;
  return { ...safe, mfa: { enabled: Boolean(mfa?.enabled), setupPending: Boolean(mfa?.pendingSecretSealed), recoveryCodesRemaining: Number(mfa?.recoveryCodesRemaining || 0) } };
}

async function handleApi(req, res, url, requestId) {
  if (!sameOriginAllowed(req)) return json(res, 403, { error: 'Origem não permitida.' }, requestId);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { ok: true, service: 'central-juridica', version: appVersion, backend, documentEncryption: Boolean(documentKeyring), documentStorageMode, documentsEnabled, productionGuard: process.env.CJ_ENV === 'production', integrations: { googleConfigured, openaiConfigured, googleEnabled, aiEnabled, sanEnabled: san.enabled }, san: { mode: 'read-only', contractVersion: sanOpenApi.info.version, baseUrlBound: Boolean(san.baseUrl) }, requestSecurity: { rateLimitBackend: rateLimiter.backend, sessionBackend: backend === 'postgres' ? 'postgres-table' : 'json-state', userBackend: backend === 'postgres' ? 'postgres-table' : 'json-state', auditBackend: store.supportsDedicatedAudit ? 'postgres-append-only' : 'json-state', idempotencyBackend: store.supportsDedicatedIdempotency ? 'postgres-table-hmac' : 'json-state', behindProxy, trustedProxyRules: trustedProxies.length } }, requestId);
  }

  if (req.method === 'GET' && url.pathname === '/api/ready') {
    try {
      const probe = await store.ping();
      return json(res, 200, { ok: true, service: 'central-juridica', version: appVersion, backend, probe }, requestId);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', requestId, event: 'readiness-failed', backend, message: error.message }));
      return json(res, 503, { ok: false, service: 'central-juridica', backend, error: 'Persistência indisponível.' }, requestId);
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/san/openapi.json') {
    return json(res, 200, sanOpenApi, requestId);
  }

  if (req.method === 'GET' && url.pathname === '/api/san/status') {
    requireSanService(req, san);
    const [probe, db, auditView] = await Promise.all([store.ping(), store.read(), readAuditView()]);
    const auditIntegrity = verifyAuditChain(auditView, auditKeyring).ok;
    return json(res, 200, {
      service: 'central-juridica', version: appVersion, mode: 'read-only', baseUrl: san.baseUrl, backend,
      ready: Boolean(probe?.ok ?? true) && auditIntegrity, auditIntegrity,
      counts: { clients: db.clients.length, processes: db.processes.length, openTasks: db.tasks.filter(t => t.status !== 'Concluída').length, agreements: db.agreements.length, executionActions: db.executionActions.length, financialEntries: db.financialEntries.length, preventiveAssessments: db.preventiveAssessments.length, externalEvidence: db.externalEvidence.length, documents: db.documents.length },
      allowedActions: SAN_ALLOWED_ACTIONS, forbiddenActions: SAN_FORBIDDEN_ACTIONS
    }, requestId);
  }

  if (req.method === 'GET' && url.pathname === '/api/san/gates') {
    requireSanService(req, san);
    const db = await store.read();
    const requiredRoles = requiredMfaRoles();
    const mfaPolicyCompliant = db.users.filter(u => u.active !== false && requiredRoles.has(u.role)).every(u => u.mfa?.enabled === true);
    const requestSecurityReady = rateLimiter.backend === 'postgres' && (!behindProxy || trustedProxies.length > 0);
    const auditView = await readAuditView();
    const auditIntegrityReady = verifyAuditChain(auditView, auditKeyring).ok && (backend !== 'postgres' || store.supportsDedicatedAudit === true);
    const runtimeReadiness = evaluateRuntimeReadiness({
      production: process.env.CJ_ENV === 'production', postgres: backend === 'postgres', documentStoragePostgres: postgresDocumentStorage,
      documentKeyring: Boolean(documentKeyring), backupKeyring: Boolean(backupKeyring), secureCookie: process.env.CJ_SECURE_COOKIE === 'true',
      mfaPolicyCompliant, requestSecurity: requestSecurityReady, auditIntegrity: auditIntegrityReady,
      capabilities: { sessions: store.supportsDedicatedSessions === true, users: store.supportsDedicatedUsers === true, audit: store.supportsDedicatedAudit === true, idempotency: store.supportsDedicatedIdempotency === true, tasks: store.supportsDedicatedTasks === true, processes: store.supportsDedicatedProcesses === true, agreements: store.supportsDedicatedAgreements === true, executionActions: store.supportsDedicatedExecutionActions === true, financialEntries: store.supportsDedicatedFinancialEntries === true, preventiveAssessments: store.supportsDedicatedPreventiveAssessments === true, externalEvidence: store.supportsDedicatedExternalEvidence === true, clients: store.supportsDedicatedClients === true, documents: store.supportsDedicatedDocuments === true, documentBlobs: store.supportsDocumentBlobs === true, atomicSnapshot: store.supportsAtomicSnapshot === true, sharedRateLimit: rateLimiter.backend === 'postgres' }
    });
    return json(res, 200, { service: 'central-juridica', version: appVersion, mode: 'read-only', runtimeReadiness, auditIntegrity: auditIntegrityReady }, requestId);
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    const body = await readBody(req, 16 * 1024);
    const username = normalizeText(body.username, 64);
    const ip = resolveClientIp(req, trustedProxies);
    const ipRateKey = hashRateLimitKey('login-ip', ip);
    const userRateKey = hashRateLimitKey('login-user', username || '<empty>');
    const [ipAttempt, userAttempt] = await Promise.all([
      rateLimiter.consume(ipRateKey, LOGIN_RATE_LIMIT),
      rateLimiter.consume(userRateKey, LOGIN_RATE_LIMIT)
    ]);
    if (!ipAttempt.allowed || !userAttempt.allowed) {
      const resetAt = Math.max(Date.parse(ipAttempt.resetAt), Date.parse(userAttempt.resetAt));
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))));
      return json(res, 429, { error: 'Muitas tentativas. Tente novamente mais tarde.' }, requestId);
    }
    const user = await store.findUserByUsername(username);
    if (user?.active === false) return json(res, 401, { error: 'Credenciais inválidas.' }, requestId);
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      return json(res, 401, { error: 'Credenciais inválidas.' }, requestId);
    }
    let mfaMethod = 'none';
    if (user.mfa?.enabled) {
      let mfaOk = false;
      if (body.mfaCode) {
        try { mfaOk = verifyTotp(openMfaSecret(user.mfa.secretSealed, mfaKeyring), body.mfaCode); } catch { mfaOk = false; }
        if (mfaOk) mfaMethod = 'totp';
      } else if (body.recoveryCode) {
        let consumed = false;
        await store.mutate(state => {
          const liveUser = state.users.find(u => u.id === user.id);
          if (liveUser?.mfa?.enabled && consumeRecoveryCode(liveUser.mfa, body.recoveryCode, mfaKeyring)) {
            consumed = true;
            liveUser.updatedAt = new Date().toISOString();
            addAudit(state, { user: liveUser }, requestId, 'MFA_RECOVERY_CODE_USED', 'user', liveUser.id, { remaining: liveUser.mfa.recoveryCodesRemaining });
          }
        });
        mfaOk = consumed;
        if (mfaOk) mfaMethod = 'recovery';
      } else {
        return json(res, 401, { error: 'Segundo fator obrigatório.', mfaRequired: true }, requestId);
      }
      if (!mfaOk) {
        return json(res, 401, { error: 'Código MFA inválido.', mfaRequired: true }, requestId);
      }
    }
    await Promise.all([rateLimiter.reset(ipRateKey), rateLimiter.reset(userRateKey)]);
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashSessionToken(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 8 * 60 * 60_000).toISOString();
    await store.transaction(async tx => {
      await tx.createSession({ id: newId('ses'), tokenHash, userId: user.id, createdAt: now.toISOString(), expiresAt }, { replaceUserSessions: true, now: now.getTime() });
      addAudit(tx.state, { user }, requestId, 'LOGIN', 'session', user.id, { mfaMethod, mfaEnabled: Boolean(user.mfa?.enabled), sessionBackend: backend === 'postgres' ? 'postgres-table' : 'json-state' });
    });
    securityHeaders(res);
    res.statusCode = 200;
    res.setHeader('Set-Cookie', `cj_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.CJ_SECURE_COOKIE === 'true' ? '; Secure' : ''}`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true, user: publicUser(user), mfaEnrollmentRequired: isMfaRequired(user.role) && !user.mfa?.enabled }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const session = await currentSession(req);
    if (session) await store.transaction(async tx => { await tx.revokeSession(session.tokenHash); addAudit(tx.state, session, requestId, 'LOGOUT', 'session', session.user.id, {}); });
    securityHeaders(res);
    res.statusCode = 200;
    res.setHeader('Set-Cookie', `cj_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${process.env.CJ_SECURE_COOKIE === 'true' ? '; Secure' : ''}`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const session = await currentSession(req);
  if (!session) return json(res, 401, { error: 'Não autenticado.' }, requestId);

  if (req.method === 'GET' && url.pathname === '/api/session') return json(res, 200, { authenticated: true, user: publicUser(session.user), mfaEnrollmentRequired: isMfaRequired(session.user.role) && !session.user.mfa?.enabled }, requestId);


  if (req.method === 'POST' && url.pathname === '/api/users/me/mfa/setup') {
    requirePermission(session, 'users:self');
    const body = await readBody(req, 16 * 1024);
    if (!(await verifyPassword(body.currentPassword, session.user.passwordHash))) return json(res, 401, { error: 'Senha atual inválida.' }, requestId);
    if (session.user.mfa?.enabled) return json(res, 409, { error: 'MFA já está ativado.' }, requestId);
    const secret = generateTotpSecret();
    const sealed = sealMfaSecret(secret, mfaKeyring);
    await store.mutate(state => {
      const user = state.users.find(u => u.id === session.user.id);
      if (!user) throw Object.assign(new Error('Usuário não encontrado.'), { status: 404 });
      user.mfa = { ...(user.mfa || {}), enabled: false, pendingSecretSealed: sealed, setupStartedAt: new Date().toISOString(), recoveryCodeHashes: [], recoveryCodesRemaining: 0 };
      user.updatedAt = new Date().toISOString();
      addAudit(state, session, requestId, 'MFA_SETUP_STARTED', 'user', user.id, { secretPersistedEncrypted: true });
    });
    return json(res, 200, { ok: true, secret, otpauthUri: makeOtpAuthUri({ secret, username: session.user.username }), warning: 'O segredo é exibido somente para configuração. Não o compartilhe.' }, requestId);
  }

  if (req.method === 'POST' && url.pathname === '/api/users/me/mfa/enable') {
    requirePermission(session, 'users:self');
    const body = await readBody(req, 16 * 1024);
    const db = await store.read();
    const liveUser = db.users.find(u => u.id === session.user.id);
    if (!liveUser?.mfa?.pendingSecretSealed) return json(res, 409, { error: 'Configuração MFA pendente não encontrada.' }, requestId);
    let secret;
    try { secret = openMfaSecret(liveUser.mfa.pendingSecretSealed, mfaKeyring); } catch { return json(res, 500, { error: 'Segredo MFA indisponível.' }, requestId); }
    if (!verifyTotp(secret, body.code)) return json(res, 400, { error: 'Código TOTP inválido.' }, requestId);
    const recoveryCodes = generateRecoveryCodes(8);
    const recoveryCodeHashes = recoveryCodes.map(code => hashRecoveryCode(code, mfaKeyring));
    await store.transaction(async tx => {
      const user = tx.state.users.find(u => u.id === session.user.id);
      if (!user) throw Object.assign(new Error('Usuário não encontrado.'), { status: 404 });
      user.mfa = { enabled: true, secretSealed: user.mfa.pendingSecretSealed, enabledAt: new Date().toISOString(), recoveryCodeHashes, recoveryCodesRemaining: recoveryCodeHashes.length };
      user.updatedAt = new Date().toISOString();
      const revoked = await tx.revokeUserSessions(user.id);
      addAudit(tx.state, session, requestId, 'MFA_ENABLED', 'user', user.id, { recoveryCodesIssued: recoveryCodeHashes.length, sessionsRevoked: revoked });
    });
    securityHeaders(res);
    res.statusCode = 200;
    res.setHeader('Set-Cookie', `cj_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${process.env.CJ_SECURE_COOKIE === 'true' ? '; Secure' : ''}`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true, recoveryCodes, reauthenticationRequired: true }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/users/me/mfa/recovery/regenerate') {
    requirePermission(session, 'users:self');
    const body = await readBody(req, 16 * 1024);
    if (!(await verifyPassword(body.currentPassword, session.user.passwordHash))) return json(res, 401, { error: 'Senha atual inválida.' }, requestId);
    if (!session.user.mfa?.enabled) return json(res, 409, { error: 'MFA não está ativado.' }, requestId);
    let secret;
    try { secret = openMfaSecret(session.user.mfa.secretSealed, mfaKeyring); } catch { return json(res, 500, { error: 'Segredo MFA indisponível.' }, requestId); }
    if (!verifyTotp(secret, body.code)) return json(res, 400, { error: 'Código TOTP inválido.' }, requestId);
    const recoveryCodes = generateRecoveryCodes(8);
    const hashes = recoveryCodes.map(code => hashRecoveryCode(code, mfaKeyring));
    await store.mutate(state => {
      const user = state.users.find(u => u.id === session.user.id);
      user.mfa.recoveryCodeHashes = hashes;
      user.mfa.recoveryCodesRemaining = hashes.length;
      user.mfa.recoveryCodesRegeneratedAt = new Date().toISOString();
      user.updatedAt = new Date().toISOString();
      addAudit(state, session, requestId, 'MFA_RECOVERY_CODES_REGENERATED', 'user', user.id, { count: hashes.length });
    });
    return json(res, 200, { ok: true, recoveryCodes }, requestId);
  }

  if (req.method === 'POST' && url.pathname === '/api/users/me/mfa/disable') {
    requirePermission(session, 'users:self');
    if (isMfaRequired(session.user.role)) return json(res, 409, { error: 'MFA é obrigatório para este perfil no ambiente atual.' }, requestId);
    const body = await readBody(req, 16 * 1024);
    if (!(await verifyPassword(body.currentPassword, session.user.passwordHash))) return json(res, 401, { error: 'Senha atual inválida.' }, requestId);
    if (!session.user.mfa?.enabled) return json(res, 409, { error: 'MFA não está ativado.' }, requestId);
    let secret; try { secret = openMfaSecret(session.user.mfa.secretSealed, mfaKeyring); } catch { return json(res, 500, { error: 'Segredo MFA indisponível.' }, requestId); }
    if (!verifyTotp(secret, body.code)) return json(res, 400, { error: 'Código TOTP inválido.' }, requestId);
    await store.transaction(async tx => {
      const user = tx.state.users.find(u => u.id === session.user.id);
      user.mfa = { enabled: false, disabledAt: new Date().toISOString(), recoveryCodesRemaining: 0 };
      user.updatedAt = new Date().toISOString();
      const revoked = await tx.revokeUserSessions(user.id);
      addAudit(tx.state, session, requestId, 'MFA_DISABLED', 'user', user.id, { sessionsRevoked: revoked });
    });
    return json(res, 200, { ok: true, reauthenticationRequired: true }, requestId);
  }

  const enrollmentRequired = isMfaRequired(session.user.role) && !session.user.mfa?.enabled;
  if (enrollmentRequired && !['/api/logout','/api/users/me/password'].includes(url.pathname)) {
    return json(res, 403, { error: 'Ativação de MFA obrigatória para este perfil.', mfaEnrollmentRequired: true }, requestId);
  }

  if (req.method === 'PATCH' && url.pathname === '/api/users/me/password') {
    requirePermission(session, 'users:self');
    const body = await readBody(req, 16 * 1024);
    if (!(await verifyPassword(body.currentPassword, session.user.passwordHash))) return json(res, 401, { error: 'Senha atual inválida.' }, requestId);
    const validation = validateNewPassword(body.newPassword, { username: session.user.username, currentPassword: body.currentPassword });
    if (!validation.ok) return json(res, 400, { error: validation.error }, requestId);
    if (await verifyPassword(validation.value, session.user.passwordHash)) return json(res, 400, { error: 'A nova senha deve ser diferente da senha atual.' }, requestId);
    const passwordHash = await hashPassword(validation.value);
    await store.transaction(async tx => {
      const user = tx.state.users.find(u => u.id === session.user.id);
      if (!user) throw Object.assign(new Error('Usuário não encontrado.'), { status: 404 });
      user.passwordHash = passwordHash;
      user.passwordChangedAt = new Date().toISOString();
      user.updatedAt = user.passwordChangedAt;
      const revoked = await tx.revokeUserSessions(user.id);
      addAudit(tx.state, session, requestId, 'PASSWORD_CHANGED', 'user', user.id, { sessionsRevoked: revoked });
    });
    securityHeaders(res);
    res.statusCode = 200;
    res.setHeader('Set-Cookie', `cj_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${process.env.CJ_SECURE_COOKIE === 'true' ? '; Secure' : ''}`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true, reauthenticationRequired: true }));
    return;
  }

  const resetPasswordMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/reset-password$/);
  if (req.method === 'POST' && resetPasswordMatch) {
    requirePermission(session, 'users:manage');
    const userId = decodeURIComponent(resetPasswordMatch[1]);
    const body = await readBody(req, 16 * 1024);
    const db = await store.read();
    const target = db.users.find(u => u.id === userId);
    if (!target) return json(res, 404, { error: 'Usuário não encontrado.' }, requestId);
    const validation = validateNewPassword(body.newPassword, { username: target.username });
    if (!validation.ok) return json(res, 400, { error: validation.error }, requestId);
    if (await verifyPassword(validation.value, target.passwordHash)) return json(res, 400, { error: 'A nova senha deve ser diferente da senha atual.' }, requestId);
    const passwordHash = await hashPassword(validation.value);
    await store.transaction(async tx => {
      const user = tx.state.users.find(u => u.id === userId);
      if (!user) throw Object.assign(new Error('Usuário não encontrado.'), { status: 404 });
      user.passwordHash = passwordHash;
      user.passwordChangedAt = new Date().toISOString();
      user.updatedAt = user.passwordChangedAt;
      const revoked = await tx.revokeUserSessions(user.id);
      addAudit(tx.state, session, requestId, 'PASSWORD_RESET_BY_ADMIN', 'user', user.id, { targetUsername: user.username, sessionsRevoked: revoked });
    });
    return json(res, 200, { ok: true, userId, sessionsRevoked: true }, requestId);
  }

  const revokeSessionsMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/revoke-sessions$/);
  if (req.method === 'POST' && revokeSessionsMatch) {
    requirePermission(session, 'users:manage');
    const userId = decodeURIComponent(revokeSessionsMatch[1]);
    const db = await store.read();
    const target = db.users.find(u => u.id === userId);
    if (!target) return json(res, 404, { error: 'Usuário não encontrado.' }, requestId);
    let revoked = 0;
    await store.transaction(async tx => {
      revoked = await tx.revokeUserSessions(userId);
      addAudit(tx.state, session, requestId, 'SESSIONS_REVOKED_BY_ADMIN', 'user', userId, { targetUsername: target.username, sessionsRevoked: revoked });
    });
    return json(res, 200, { ok: true, userId, revoked }, requestId);
  }

  if (req.method === 'GET' && url.pathname === '/api/audit/integrity') {
    requirePermission(session, 'audit:read');
    const audit = await readAuditView();
    const verification = verifyAuditChain(audit, auditKeyring);
    return json(res, verification.ok ? 200 : 409, verification, requestId);
  }

  if (req.method === 'GET' && url.pathname === '/api/security/keyrings') {
    requirePermission(session, 'audit:read');
    return json(res, 200, {
      document: documentKeyring ? publicKeyringStatus(documentKeyring) : { configured: false },
      audit: publicKeyringStatus(auditKeyring),
      mfa: publicKeyringStatus(mfaKeyring),
      note: 'Somente IDs e contagens são expostos; material criptográfico permanece fora do banco e da API.'
    }, requestId);
  }

  if (req.method === 'GET' && url.pathname === '/api/audit/gates') {
    requirePermission(session, 'audit:read');
    const db = await store.read();
    const requiredRoles = requiredMfaRoles();
    const mfaPolicyCompliant = db.users.filter(u => u.active !== false && requiredRoles.has(u.role)).every(u => u.mfa?.enabled === true);
    const requestSecurityReady = rateLimiter.backend === 'postgres' && (!behindProxy || trustedProxies.length > 0);
    const auditView = await readAuditView();
    const auditIntegrityReady = verifyAuditChain(auditView, auditKeyring).ok && (backend !== 'postgres' || store.supportsDedicatedAudit === true);
    const runtimeReadiness = evaluateRuntimeReadiness({
      production: process.env.CJ_ENV === 'production',
      postgres: backend === 'postgres',
      documentStoragePostgres: postgresDocumentStorage,
      documentKeyring: Boolean(documentKeyring),
      backupKeyring: Boolean(backupKeyring),
      secureCookie: process.env.CJ_SECURE_COOKIE === 'true',
      mfaPolicyCompliant, requestSecurity: requestSecurityReady, auditIntegrity: auditIntegrityReady,
      capabilities: {
        sessions: store.supportsDedicatedSessions === true, users: store.supportsDedicatedUsers === true,
        audit: store.supportsDedicatedAudit === true, idempotency: store.supportsDedicatedIdempotency === true,
        tasks: store.supportsDedicatedTasks === true, processes: store.supportsDedicatedProcesses === true,
        agreements: store.supportsDedicatedAgreements === true, executionActions: store.supportsDedicatedExecutionActions === true,
        financialEntries: store.supportsDedicatedFinancialEntries === true, preventiveAssessments: store.supportsDedicatedPreventiveAssessments === true,
        externalEvidence: store.supportsDedicatedExternalEvidence === true, clients: store.supportsDedicatedClients === true,
        documents: store.supportsDedicatedDocuments === true, documentBlobs: store.supportsDocumentBlobs === true,
        atomicSnapshot: store.supportsAtomicSnapshot === true, sharedRateLimit: rateLimiter.backend === 'postgres'
      }
    });
    return json(res, 200, { ...evaluateAuditGates({ db, googleEnabled, googleConfigured, openaiEnabled: aiEnabled, openaiConfigured, coreRuntimeReady: runtimeReadiness.ready, version: appVersion }), runtimeReadiness }, requestId);
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard') {
    requirePermission(session, 'dashboard:read');
    const db = await store.read();
    const clientMap = new Map(db.clients.map(c => [c.id, c.name]));
    const enrichedProcesses = db.processes.map(p => ({ ...p, clientName: clientMap.get(p.clientId) || '' }));
    const brief = buildDailyBrief({ processes: enrichedProcesses, tasks: db.tasks, timeZone: process.env.CJ_TIMEZONE || 'America/Sao_Paulo' });
    return json(res, 200, { stats: dashboardStats(db, new Date(), process.env.CJ_TIMEZONE || 'America/Sao_Paulo'), brief, recentProcesses: enrichedProcesses.slice().sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0,6), tasks: db.tasks.filter(t => t.status !== 'Concluída').slice(0,8) }, requestId);
  }

  if (req.method === 'GET' && url.pathname === '/api/users') {
    requirePermission(session, 'users:manage');
    const db = await store.read();
    return json(res, 200, { users: db.users.map(publicUser) }, requestId);
  }

  if (req.method === 'POST' && url.pathname === '/api/users') {
    requirePermission(session, 'users:manage');
    const body = await readBody(req, 32 * 1024);
    const username = normalizeText(body.username, 64);
    const name = normalizeText(body.name, 160);
    const role = validateRole(body.role);
    if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username)) return json(res, 400, { error: 'Usuário deve possuir 3–64 caracteres válidos.' }, requestId);
    if (name.length < 2) return json(res, 400, { error: 'Nome é obrigatório.' }, requestId);
    if (!role) return json(res, 400, { error: 'Perfil inválido.' }, requestId);
    const passwordValidation = validateNewPassword(body.password, { username });
    if (!passwordValidation.ok) return json(res, 400, { error: passwordValidation.error }, requestId);
    const passwordHash = await hashPassword(passwordValidation.value);
    const result = await idempotentCreate(req, 'user', async providedDb => {
      const createInto = async db => {
        if (db.users.some(u => u.username.toLowerCase() === username.toLowerCase())) throw Object.assign(new Error('Usuário já cadastrado.'), { status: 409 });
        const now = new Date().toISOString();
        const user = { id: newId('usr'), username, name, role, passwordHash, active: true, createdAt: now, updatedAt: now };
        db.users.push(user);
        addAudit(db, session, requestId, 'CREATE', 'user', user.id, { username, role });
        return { user: publicUser(user) };
      };
      return providedDb ? createInto(providedDb) : store.mutate(createInto);
    });
    return json(res, result.replayed ? 200 : 201, result, requestId);
  }

  if (req.method === 'GET' && url.pathname === '/api/clients') {
    requirePermission(session, 'clients:read');
    const clients = store.supportsDedicatedClients ? await store.listClients() : (await store.read()).clients;
    return json(res, 200, { clients }, requestId);
  }

  if (req.method === 'POST' && url.pathname === '/api/clients') {
    requirePermission(session, 'clients:write');
    const body = await readBody(req);
    const validation = validateClient(body);
    if (!validation.ok) return json(res, 400, { error: validation.error }, requestId);
    const now = new Date().toISOString();
    const client = { id: newId('cli'), ...validation.value, createdAt: now, updatedAt: now };
    const auditFields={id:newId('audit'),action:'CREATE',entity:'client',entityId:client.id,requestId,actor:{id:session.user.id,role:session.user.role},detail:{name:client.name},at:now};
    let result; const rawKey=String(req.headers['idempotency-key']||'').trim();
    if(store.supportsDedicatedClients) result=rawKey?await store.idempotentClientCreate(rawKey,client,auditFields):await store.createDedicatedClient(client,auditFields);
    else result=await idempotentCreate(req,'client',async providedDb=>{const createInto=async db=>{db.clients.unshift(client);addAudit(db,session,requestId,'CREATE','client',client.id,{name:client.name});return{client}};return providedDb?createInto(providedDb):store.mutate(createInto)});
    return json(res, result.replayed ? 200 : 201, result, requestId);
  }

  if (req.method === 'GET' && url.pathname === '/api/processes') {
    requirePermission(session, 'processes:read');
    const db = await store.read();
    const clientMap = Object.fromEntries(db.clients.map(c => [c.id, c.name]));
    const processes = store.supportsDedicatedProcesses ? await store.listProcesses() : db.processes;
    return json(res, 200, { processes: processes.map(p => ({ ...p, clientName: clientMap[p.clientId] || '—' })) }, requestId);
  }

  if (req.method === 'POST' && url.pathname === '/api/processes') {
    requirePermission(session, 'processes:write');
    const body = await readBody(req);
    const dbSnapshot = await store.read();
    const validation = validateProcess(body, new Set(dbSnapshot.clients.map(c => c.id)));
    if (!validation.ok) return json(res, 400, { error: validation.error }, requestId);
    const now = new Date().toISOString();
    const processRecord = { id: newId('proc'), ...validation.value, createdAt: now, updatedAt: now };
    const auditFields={id:`audit_${crypto.randomUUID()}`,action:'CREATE',entity:'process',entityId:processRecord.id,requestId,actor:{id:session.user.id,role:session.user.role},detail:{title:processRecord.title},at:now};
    let result; const rawKey=String(req.headers['idempotency-key']||'').trim();
    if(store.supportsDedicatedProcesses){ result=rawKey ? await store.idempotentProcessCreate(rawKey,processRecord,auditFields) : await store.createDedicatedProcess(processRecord,auditFields); }
    else { result=await idempotentCreate(req,'process',async providedDb=>{const createInto=async db=>{if(!db.clients.some(c=>c.id===validation.value.clientId))throw Object.assign(new Error('Cliente não encontrado.'),{status:409});db.processes.unshift(processRecord);addAudit(db,session,requestId,'CREATE','process',processRecord.id,{title:processRecord.title});return{process:processRecord}};return providedDb?createInto(providedDb):store.mutate(createInto)}); }
    return json(res,result.replayed?200:201,result,requestId);
  }

  const processMatch = url.pathname.match(/^\/api\/processes\/([^/]+)$/);
  if (req.method === 'GET' && processMatch) {
    requirePermission(session, 'processes:read');
    const db = await store.read();
    const processRecord = store.supportsDedicatedProcesses ? await store.findProcessById(processMatch[1]) : db.processes.find(p => p.id === processMatch[1]);
    if (!processRecord) return json(res, 404, { error: 'Processo não encontrado.' }, requestId);
    return json(res, 200, { process: processRecord, client: db.clients.find(c => c.id === processRecord.clientId) || null, documents: db.documents.filter(d => d.processId === processRecord.id) }, requestId);
  }

  if (req.method === 'PATCH' && processMatch) {
    requirePermission(session, 'processes:write');
    const body = await readBody(req); const id=processMatch[1];
    if(store.supportsDedicatedProcesses){
      const current=await store.findProcessById(id); if(!current)throw Object.assign(new Error('Processo não encontrado.'),{status:404});
      const db=await store.read(); const merged={...current,...body,clientId:body.clientId??current.clientId}; const validation=validateProcess(merged,new Set(db.clients.map(c=>c.id))); if(!validation.ok)throw Object.assign(new Error(validation.error),{status:400});
      const updated={...current,...validation.value,updatedAt:new Date().toISOString()}; await store.updateDedicatedProcess(updated,{id:`audit_${crypto.randomUUID()}`,action:'UPDATE',entity:'process',entityId:id,requestId,actor:{id:session.user.id,role:session.user.role},detail:{fields:Object.keys(body)},at:updated.updatedAt}); return json(res,200,{process:updated},requestId);
    }
    const result=await store.mutate(db=>{const idx=db.processes.findIndex(p=>p.id===id);if(idx<0)throw Object.assign(new Error('Processo não encontrado.'),{status:404});const merged={...db.processes[idx],...body,clientId:body.clientId??db.processes[idx].clientId};const validation=validateProcess(merged,new Set(db.clients.map(c=>c.id)));if(!validation.ok)throw Object.assign(new Error(validation.error),{status:400});const updated={...db.processes[idx],...validation.value,updatedAt:new Date().toISOString()};db.processes[idx]=updated;addAudit(db,session,requestId,'UPDATE','process',id,{fields:Object.keys(body)});return updated});return json(res,200,{process:result},requestId);
  }

  const auditMatch = url.pathname.match(/^\/api\/processes\/([^/]+)\/audit$/);
  if (req.method === 'POST' && auditMatch) {
    requirePermission(session, 'processes:audit');
    const db = await store.read();
    const process = db.processes.find(p => p.id === auditMatch[1]);
    if (!process) return json(res, 404, { error: 'Processo não encontrado.' }, requestId);
    const audit = auditProcess(process, new Date(), process.env.CJ_TIMEZONE || 'America/Sao_Paulo');
    await store.mutate(state => addAudit(state, session, requestId, 'AUDIT_LOCAL', 'process', process.id, { decision: audit.decision, score: audit.score }));
    return json(res, 200, { audit }, requestId);
  }

  if (req.method === 'GET' && url.pathname === '/api/tasks') {
    requirePermission(session, 'tasks:read');
    const tasks = store.supportsDedicatedTasks ? await store.listTasks() : (await store.read()).tasks;
    return json(res, 200, { tasks }, requestId);
  }

  if (req.method === 'POST' && url.pathname === '/api/tasks') {
    requirePermission(session, 'tasks:write'); const body=await readBody(req); const dbSnapshot=await store.read();
    const validation=validateTask(body,new Set(dbSnapshot.processes.map(p=>p.id))); if(!validation.ok)return json(res,400,{error:validation.error},requestId);
    const now=new Date().toISOString(); const task={id:newId('task'),...validation.value,createdAt:now,updatedAt:now};
    let result; const rawKey=String(req.headers['idempotency-key']||'').trim();
    const taskAudit={id:`audit_${crypto.randomUUID()}`,action:'CREATE',entity:'task',entityId:task.id,requestId,actor:{id:session.user.id,role:session.user.role},detail:{title:task.title},at:now};
    if(store.supportsDedicatedTasks){ result=rawKey ? await store.idempotentTaskCreate(rawKey,task,taskAudit) : await store.createDedicatedTask(task,taskAudit); }
    else { result=await idempotentCreate(req,'task',async db=>{const createInto=async x=>{x.tasks.unshift(task);addAudit(x,session,requestId,'CREATE','task',task.id,{title:task.title});return{task}};return db?createInto(db):store.mutate(createInto)}); }
    return json(res,result.replayed?200:201,result,requestId);
  }

  const taskMatch=url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if(req.method==='PATCH'&&taskMatch){ requirePermission(session,'tasks:write'); const body=await readBody(req),id=taskMatch[1];
    if(store.supportsDedicatedTasks){const current=await store.findTaskById(id);if(!current)throw Object.assign(new Error('Tarefa não encontrada.'),{status:404});const db=await store.read();const validation=validateTask({...current,...body},new Set(db.processes.map(p=>p.id)));if(!validation.ok)throw Object.assign(new Error(validation.error),{status:400});const updated={...current,...validation.value,updatedAt:new Date().toISOString()};await store.updateDedicatedTask(updated,{id:`audit_${crypto.randomUUID()}`,action:'UPDATE',entity:'task',entityId:id,requestId,actor:{id:session.user.id,role:session.user.role},detail:{fields:Object.keys(body)},at:updated.updatedAt});return json(res,200,{task:updated},requestId);}
    const result=await store.mutate(db=>{const idx=db.tasks.findIndex(t=>t.id===id);if(idx<0)throw Object.assign(new Error('Tarefa não encontrada.'),{status:404});const validation=validateTask({...db.tasks[idx],...body},new Set(db.processes.map(p=>p.id)));if(!validation.ok)throw Object.assign(new Error(validation.error),{status:400});const updated={...db.tasks[idx],...validation.value,updatedAt:new Date().toISOString()};db.tasks[idx]=updated;addAudit(db,session,requestId,'UPDATE','task',id,{fields:Object.keys(body)});return updated});return json(res,200,{task:result},requestId);
  }

  if (req.method === 'GET' && url.pathname === '/api/documents') {
    requirePermission(session, 'documents:read');
    const processId = url.searchParams.get('processId');
    const documents = store.supportsDedicatedDocuments ? await store.listDocuments() : (await store.read()).documents;
    return json(res, 200, { documents: processId ? documents.filter(d => d.processId === processId) : documents }, requestId);
  }

  if (req.method === 'POST' && url.pathname === '/api/documents') {
    requirePermission(session, 'documents:write');
    if (!documentsEnabled) return json(res, 503, { error: 'Armazenamento documental persistente não configurado neste ambiente.' }, requestId);
    const body = await readBody(req);
    const dbSnapshot = await store.read();
    const validation = validateDocumentInput(body, new Set(dbSnapshot.processes.map(p => p.id)));
    if (!validation.ok) return json(res, 400, { error: validation.error }, requestId);
    const docData = validation.value;

    if (postgresDocumentStorage && store.supportsDedicatedDocuments) {
      const key = String(req.headers['idempotency-key'] || '').trim();
      if (key.length > 120) return json(res, 400, { error: 'Idempotency-Key inválida.' }, requestId);
      const id = newId('doc');
      const storedBytes = encryptBuffer(docData.bytes, documentKeyring);
      const storedSha256 = crypto.createHash('sha256').update(storedBytes).digest('hex');
      const now = new Date().toISOString();
      const document = { id, name: docData.name, processId: docData.processId, mimeType: docData.mimeType, size: docData.size, sha256: docData.sha256, storedSha256, storageBackend: 'postgres', storageName: null, encrypted: Boolean(documentKeyring), encryptionKeyId: encryptedBufferKeyId(storedBytes, { legacyKeyId: documentKeyring?.legacyKeyId }), uploadedBy: session.user.id, createdAt: now };
      const auditFields={id:newId('audit'),action:'UPLOAD',entity:'document',entityId:id,requestId,actor:{id:session.user.id,role:session.user.role},detail:{name:document.name,processId:document.processId,sha256:document.sha256,storedSha256,size:document.size,storageBackend:'postgres'},at:now};
      const result=await store.createDedicatedDocument(document,storedBytes,auditFields,key||null);
      return json(res, result.replayed || result.duplicate ? 200 : 201, result, requestId);
    }

    if (postgresDocumentStorage) {
      if (!store.supportsDocumentBlobs || typeof store.transaction !== 'function') return json(res, 503, { error: 'Adapter PostgreSQL não suporta blobs documentais.' }, requestId);
      const key = String(req.headers['idempotency-key'] || '').trim();
      if (key.length > 120) return json(res, 400, { error: 'Idempotency-Key inválida.' }, requestId);
      const createDocument = async tx => {
        const db = tx.state;
        const duplicate = db.documents.find(d => d.sha256 === docData.sha256 && d.processId === docData.processId);
        if (duplicate) return { document: duplicate, duplicate: true };
        const id = newId('doc');
        const storedBytes = encryptBuffer(docData.bytes, documentKeyring);
        const storedSha256 = crypto.createHash('sha256').update(storedBytes).digest('hex');
        await tx.putDocumentBlob(id, storedBytes, storedSha256);
        const now = new Date().toISOString();
        const document = { id, name: docData.name, processId: docData.processId, mimeType: docData.mimeType, size: docData.size, sha256: docData.sha256, storedSha256, storageBackend: 'postgres', storageName: null, encrypted: Boolean(documentKeyring), encryptionKeyId: encryptedBufferKeyId(storedBytes, { legacyKeyId: documentKeyring?.legacyKeyId }), uploadedBy: session.user.id, createdAt: now };
        db.documents.unshift(document);
        addAudit(db, session, requestId, 'UPLOAD', 'document', id, { name: document.name, processId: document.processId, sha256: document.sha256, storedSha256, size: document.size, storageBackend: 'postgres' });
        return { document };
      };
      const result = key && store.supportsDedicatedIdempotency ? await store.idempotentTransaction('document', key, createDocument) : await store.transaction(createDocument);
      return json(res, result.replayed || result.duplicate ? 200 : 201, result, requestId);
    }

    const result = await idempotentCreate(req, 'document', async providedDb => {
      const createInto = async db => {
        const duplicate = db.documents.find(d => d.sha256 === docData.sha256 && d.processId === docData.processId);
        if (duplicate) return { document: duplicate, duplicate: true };
        const id = newId('doc');
        const storageName = safeStorageName(id, docData.name);
        const storagePath = path.join(documentDir, storageName);
        const storedBytes = encryptBuffer(docData.bytes, documentKeyring);
        await fs.writeFile(storagePath, storedBytes, { flag: 'wx', mode: 0o600 });
        const now = new Date().toISOString();
        const storedSha256 = crypto.createHash('sha256').update(storedBytes).digest('hex');
        const document = { id, name: docData.name, processId: docData.processId, mimeType: docData.mimeType, size: docData.size, sha256: docData.sha256, storedSha256, storageBackend: 'local', storageName, encrypted: Boolean(documentKeyring), encryptionKeyId: encryptedBufferKeyId(storedBytes, { legacyKeyId: documentKeyring?.legacyKeyId }), uploadedBy: session.user.id, createdAt: now };
        db.documents.unshift(document);
        addAudit(db, session, requestId, 'UPLOAD', 'document', id, { name: document.name, processId: document.processId, sha256: document.sha256, size: document.size, storageBackend: 'local' });
        return { document };
      };
      return providedDb ? createInto(providedDb) : store.mutate(createInto);
    });
    return json(res, result.replayed || result.duplicate ? 200 : 201, result, requestId);
  }

  const documentMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/content$/);
  if (req.method === 'GET' && documentMatch) {
    requirePermission(session, 'documents:read');
    if (!documentsEnabled) return json(res, 503, { error: 'Conteúdo documental indisponível: storage persistente não configurado.' }, requestId);
    const document = store.supportsDedicatedDocuments ? await store.findDocumentById(documentMatch[1]) : (await store.read()).documents.find(d => d.id === documentMatch[1]);
    if (!document) return json(res, 404, { error: 'Documento não encontrado.' }, requestId);
    let storedBytes;

    if (postgresDocumentStorage || document.storageBackend === 'postgres') {
      if (typeof store.readDocumentBlob !== 'function') return json(res, 503, { error: 'Adapter PostgreSQL não suporta leitura de blob documental.' }, requestId);
      const blob = await store.readDocumentBlob(document.id);
      if (!blob) return json(res, 404, { error: 'Conteúdo físico do documento não encontrado.' }, requestId);
      const storedHash = crypto.createHash('sha256').update(blob.payload).digest('hex');
      if (storedHash !== blob.storedSha256 || (document.storedSha256 && storedHash !== document.storedSha256)) return json(res, 409, { error: 'Integridade do blob armazenado não confere.' }, requestId);
      storedBytes = blob.payload;
    } else {
      const filePath = path.resolve(documentDir, document.storageName);
      if (!filePath.startsWith(path.resolve(documentDir) + path.sep)) return json(res, 500, { error: 'Referência documental inválida.' }, requestId);
      try { storedBytes = await fs.readFile(filePath); } catch { return json(res, 404, { error: 'Conteúdo físico do documento não encontrado.' }, requestId); }
    }

    let bytes;
    try { bytes = document.encrypted ? decryptBuffer(storedBytes, documentKeyring) : storedBytes; } catch (error) { return json(res, Number(error.status)||409, { error: error.message }, requestId); }
    const actualHash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== document.sha256) return json(res, 409, { error: 'Integridade do documento não confere com o hash registrado.' }, requestId);
    securityHeaders(res);
    res.statusCode = 200;
    res.setHeader('Content-Type', document.mimeType);
    res.setHeader('Content-Length', bytes.length);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(document.name)}`);
    res.setHeader('X-Request-Id', requestId);
    res.end(bytes);
    return;
  }


  if (req.method === 'GET' && url.pathname === '/api/evidence') {
    requirePermission(session, 'evidence:read');
    const db = await store.read();
    const status = url.searchParams.get('status');
    const processId = url.searchParams.get('processId');
    const processMap = new Map(db.processes.map(p => [p.id, p.title]));
    let items = store.supportsDedicatedExternalEvidence ? await store.listExternalEvidence() : db.externalEvidence.slice();
    if (status) items = items.filter(item => item.status === status);
    if (processId) items = items.filter(item => item.processId === processId || item.proposedProcessId === processId);
    items = items.map(item => ({ ...publicEvidence(item), processTitle: item.processId ? (processMap.get(item.processId) || '') : '', proposedProcessTitle: item.proposedProcessId ? (processMap.get(item.proposedProcessId) || '') : '' }));
    return json(res, 200, { items, summary: evidenceQueueSummary(items) }, requestId);
  }

  if (req.method === 'POST' && url.pathname === '/api/evidence/candidates') {
    requirePermission(session, 'evidence:ingest');
    const body = await readBody(req, 64 * 1024);
    const snapshot = await store.read();
    const validation = validateEvidenceCandidate(body, { processIds: new Set(snapshot.processes.map(p => p.id)) });
    if (!validation.ok) return json(res, 400, { error: validation.error }, requestId);
    const now = new Date().toISOString();
    const item = { id: newId('evd'), ...validation.value, status: 'Pendente', processId: null, reviewNote: null, reviewedAt: null, reviewedBy: null, createdBy: session.user.id, ingestedAt: now, createdAt: now, updatedAt: now };
    const auditFields = { id: newId('audit'), action: 'EVIDENCE_METADATA_INGESTED', entity: 'external-evidence', entityId: item.id, requestId, actor: { id: session.user.id, role: session.user.role }, detail: { provider: item.provider, kind: item.kind, metadataHash: item.metadataHash, proposedProcessId: item.proposedProcessId, contentStored: false }, at: now };
    const rawKey = String(req.headers['idempotency-key'] || '').trim();
    let result;
    if (store.supportsDedicatedExternalEvidence) {
      if (!rawKey) {
        const duplicate = await store.findExternalEvidenceByProviderExternalId(item.provider, item.externalId);
        if (duplicate) return json(res, 409, { error: 'Evidência externa já ingerida.' }, requestId);
      }
      try {
        result = rawKey ? await store.idempotentExternalEvidenceCreate(rawKey, item, auditFields) : await store.createDedicatedExternalEvidence(item, auditFields);
      } catch (error) {
        if (error?.code === '23505') return json(res, 409, { error: 'Evidência externa já ingerida.' }, requestId);
        throw error;
      }
      return json(res, result.replayed ? 200 : 201, { ...result, item: publicEvidence(result.item) }, requestId);
    }
    if (snapshot.externalEvidence.some(existing => existing.provider === validation.value.provider && existing.externalId === validation.value.externalId)) return json(res, 409, { error: 'Evidência externa já ingerida.' }, requestId);
    result = await idempotentCreate(req, 'evidence', async providedDb => {
      const createInto = async db => {
        if (db.externalEvidence.some(existing => existing.provider === validation.value.provider && existing.externalId === validation.value.externalId)) throw Object.assign(new Error('Evidência externa já ingerida.'), { status: 409 });
        db.externalEvidence.unshift(item);
        addAudit(db, session, requestId, 'EVIDENCE_METADATA_INGESTED', 'external-evidence', item.id, auditFields.detail);
        return { item: publicEvidence(item) };
      };
      return providedDb ? createInto(providedDb) : store.mutate(createInto);
    });
    return json(res, result.replayed ? 200 : 201, result, requestId);
  }

  const evidenceReviewMatch = url.pathname.match(/^\/api\/evidence\/([^/]+)\/review$/);
  if (req.method === 'PATCH' && evidenceReviewMatch) {
    requirePermission(session, 'evidence:review');
    const body = await readBody(req, 32 * 1024);
    if (store.supportsDedicatedExternalEvidence) {
      const db = await store.read();
      const processIds = new Set(db.processes.map(p => p.id));
      const updated = await store.reviewDedicatedExternalEvidence(evidenceReviewMatch[1], async current => {
        const validation = validateEvidenceReview(body, { processIds });
        if (!validation.ok) throw Object.assign(new Error(validation.error), { status: 400 });
        const now = new Date().toISOString();
        return { ...current, status: validation.value.decision === 'Vincular' ? 'Vinculado' : 'Descartado', processId: validation.value.processId, reviewNote: validation.value.reviewNote, reviewedAt: now, reviewedBy: session.user.id, updatedAt: now };
      }, next => ({ id: newId('audit'), action: next.status === 'Vinculado' ? 'EVIDENCE_LINKED' : 'EVIDENCE_DISMISSED', entity: 'external-evidence', entityId: next.id, requestId, actor: { id: session.user.id, role: session.user.role }, detail: { provider: next.provider, kind: next.kind, processId: next.processId, metadataHash: next.metadataHash, contentStored: false }, at: next.updatedAt }));
      return json(res, 200, { item: publicEvidence(updated) }, requestId);
    }
    const updated = await store.mutate(db => {
      const idx = db.externalEvidence.findIndex(item => item.id === evidenceReviewMatch[1]);
      if (idx < 0) throw Object.assign(new Error('Evidência externa não encontrada.'), { status: 404 });
      const current = db.externalEvidence[idx];
      if (current.status !== 'Pendente') throw Object.assign(new Error('Evidência já revisada; a decisão é imutável para preservar a trilha de auditoria.'), { status: 409 });
      const validation = validateEvidenceReview(body, { processIds: new Set(db.processes.map(p => p.id)) });
      if (!validation.ok) throw Object.assign(new Error(validation.error), { status: 400 });
      const now = new Date().toISOString();
      const next = { ...current, status: validation.value.decision === 'Vincular' ? 'Vinculado' : 'Descartado', processId: validation.value.processId, reviewNote: validation.value.reviewNote, reviewedAt: now, reviewedBy: session.user.id, updatedAt: now };
      db.externalEvidence[idx] = next;
      addAudit(db, session, requestId, next.status === 'Vinculado' ? 'EVIDENCE_LINKED' : 'EVIDENCE_DISMISSED', 'external-evidence', next.id, { provider: next.provider, kind: next.kind, processId: next.processId, metadataHash: next.metadataHash, contentStored: false });
      return next;
    });
    return json(res, 200, { item: publicEvidence(updated) }, requestId);
  }

  if (req.method === 'GET' && url.pathname === '/api/preventive') {
    requirePermission(session, 'preventive:read');
    const db = await store.read();
    const clientId = url.searchParams.get('clientId');
    const clientMap = new Map(db.clients.map(c => [c.id, c.name]));
    const assessments = (clientId ? db.preventiveAssessments.filter(a => a.clientId === clientId) : db.preventiveAssessments).map(a => ({ ...a, clientName: clientMap.get(a.clientId) || '', summary: preventiveSummary(a, { now: new Date(), timeZone: process.env.CJ_TIMEZONE || 'America/Sao_Paulo' }) }));
    return json(res, 200, { assessments }, requestId);
  }

  if (req.method === 'POST' && url.pathname === '/api/preventive') {
    requirePermission(session, 'preventive:write');
    const body = await readBody(req, 256 * 1024);
    const snapshot = await store.read();
    const input = { ...body, items: body.useDefaultTemplate === false ? (body.items || []) : (body.items?.length ? body.items : makeDefaultPreventiveItems()) };
    const validation = validateAssessment(input, new Set(snapshot.clients.map(c => c.id)));
    if (!validation.ok) return json(res, 400, { error: validation.error }, requestId);
    const now = new Date().toISOString();
    const assessment = { id: newId('prev'), ...validation.value, createdBy: session.user.id, createdAt: now, updatedAt: now };
    const auditFields = { id: newId('audit'), action: 'CREATE', entity: 'preventive-assessment', entityId: assessment.id, requestId, actor: { id: session.user.id, role: session.user.role }, detail: { clientId: assessment.clientId, items: assessment.items.length, status: assessment.status }, at: now };
    let result;
    if (store.supportsDedicatedPreventiveAssessments) {
      const rawKey = req.headers['idempotency-key'];
      result = rawKey ? await store.idempotentPreventiveAssessmentCreate(rawKey, assessment, auditFields) : await store.createDedicatedPreventiveAssessment(assessment, auditFields);
    } else {
      result = await idempotentCreate(req, 'preventive', async providedDb => {
        const createInto = async db => { db.preventiveAssessments.unshift(assessment); addAudit(db, session, requestId, 'CREATE', 'preventive-assessment', assessment.id, auditFields.detail); return { assessment }; };
        return providedDb ? createInto(providedDb) : store.mutate(createInto);
      });
    }
    return json(res, result.replayed ? 200 : 201, { ...result, assessment: { ...result.assessment, summary: preventiveSummary(result.assessment, { timeZone: process.env.CJ_TIMEZONE || 'America/Sao_Paulo' }) } }, requestId);
  }

  const preventiveMatch = url.pathname.match(/^\/api\/preventive\/([^/]+)$/);
  if (req.method === 'GET' && preventiveMatch) {
    requirePermission(session, 'preventive:read');
    const db = await store.read();
    const assessment = db.preventiveAssessments.find(a => a.id === preventiveMatch[1]);
    if (!assessment) return json(res, 404, { error: 'Auditoria preventiva não encontrada.' }, requestId);
    const client = db.clients.find(c => c.id === assessment.clientId) || null;
    return json(res, 200, { assessment, client, summary: preventiveSummary(assessment, { now: new Date(), timeZone: process.env.CJ_TIMEZONE || 'America/Sao_Paulo' }) }, requestId);
  }

  if (req.method === 'PATCH' && preventiveMatch) {
    requirePermission(session, 'preventive:write');
    const body = await readBody(req, 256 * 1024);
    let updated;
    if (store.supportsDedicatedPreventiveAssessments) {
      const current = await store.findPreventiveAssessmentById(preventiveMatch[1]);
      if (!current) throw Object.assign(new Error('Auditoria preventiva não encontrada.'), { status: 404 });
      const db = await store.read();
      const validation = validateAssessment(body, new Set(db.clients.map(c => c.id)), current);
      if (!validation.ok) throw Object.assign(new Error(validation.error), { status: 400 });
      const next = { ...current, ...validation.value, updatedAt: new Date().toISOString() };
      const auditFields = { id: newId('audit'), action: 'UPDATE', entity: 'preventive-assessment', entityId: next.id, requestId, actor: { id: session.user.id, role: session.user.role }, detail: { fields: Object.keys(body), status: next.status }, at: next.updatedAt };
      updated = await store.updateDedicatedPreventiveAssessment(next, auditFields);
    } else {
      updated = await store.mutate(db => {
        const idx = db.preventiveAssessments.findIndex(a => a.id === preventiveMatch[1]);
        if (idx < 0) throw Object.assign(new Error('Auditoria preventiva não encontrada.'), { status: 404 });
        const current = db.preventiveAssessments[idx];
        const validation = validateAssessment(body, new Set(db.clients.map(c => c.id)), current);
        if (!validation.ok) throw Object.assign(new Error(validation.error), { status: 400 });
        const next = { ...current, ...validation.value, updatedAt: new Date().toISOString() };
        db.preventiveAssessments[idx] = next;
        addAudit(db, session, requestId, 'UPDATE', 'preventive-assessment', next.id, { fields: Object.keys(body), status: next.status });
        return next;
      });
    }
    return json(res, 200, { assessment: updated, summary: preventiveSummary(updated, { timeZone: process.env.CJ_TIMEZONE || 'America/Sao_Paulo' }) }, requestId);
  }

  const preventiveItemMatch = url.pathname.match(/^\/api\/preventive\/([^/]+)\/items\/([^/]+)$/);
  if (req.method === 'PATCH' && preventiveItemMatch) {
    requirePermission(session, 'preventive:write');
    const body = await readBody(req, 64 * 1024);
    let result;
    if (store.supportsDedicatedPreventiveAssessments) {
      const current = await store.findPreventiveAssessmentById(preventiveItemMatch[1]);
      if (!current) throw Object.assign(new Error('Auditoria preventiva não encontrada.'), { status: 404 });
      const idx = current.items.findIndex(i => i.id === preventiveItemMatch[2]);
      if (idx < 0) throw Object.assign(new Error('Item preventivo não encontrado.'), { status: 404 });
      const validation = validateItem({ ...current.items[idx], ...body });
      if (!validation.ok) throw Object.assign(new Error(validation.error), { status: 400 });
      const items = current.items.map((item, index) => index === idx ? validation.value : item);
      const next = { ...current, items, updatedAt: new Date().toISOString() };
      const auditFields = { id: newId('audit'), action: 'UPDATE', entity: 'preventive-item', entityId: validation.value.id, requestId, actor: { id: session.user.id, role: session.user.role }, detail: { assessmentId: next.id, answer: validation.value.answer, severity: validation.value.severity, actionStatus: validation.value.actionStatus, dueDate: validation.value.dueDate }, at: next.updatedAt };
      const assessment = await store.updateDedicatedPreventiveAssessment(next, auditFields);
      result = { assessment, item: validation.value };
    } else {
      result = await store.mutate(db => {
        const assessment = db.preventiveAssessments.find(a => a.id === preventiveItemMatch[1]);
        if (!assessment) throw Object.assign(new Error('Auditoria preventiva não encontrada.'), { status: 404 });
        const idx = assessment.items.findIndex(i => i.id === preventiveItemMatch[2]);
        if (idx < 0) throw Object.assign(new Error('Item preventivo não encontrado.'), { status: 404 });
        const validation = validateItem({ ...assessment.items[idx], ...body });
        if (!validation.ok) throw Object.assign(new Error(validation.error), { status: 400 });
        assessment.items[idx] = validation.value;
        assessment.updatedAt = new Date().toISOString();
        addAudit(db, session, requestId, 'UPDATE', 'preventive-item', validation.value.id, { assessmentId: assessment.id, answer: validation.value.answer, severity: validation.value.severity, actionStatus: validation.value.actionStatus, dueDate: validation.value.dueDate });
        return { assessment, item: validation.value };
      });
    }
    return json(res, 200, { ...result, summary: preventiveSummary(result.assessment, { timeZone: process.env.CJ_TIMEZONE || 'America/Sao_Paulo' }) }, requestId);
  }


  if (req.method === 'GET' && url.pathname === '/api/finance') {
    requirePermission(session, 'finance:read');
    const db = await store.read();
    const clientId = url.searchParams.get('clientId');
    const processId = url.searchParams.get('processId');
    const clientMap = new Map(db.clients.map(c => [c.id, c.name]));
    const processMap = new Map(db.processes.map(p => [p.id, p.title]));
    const entries = filterFinancialEntries(db.financialEntries, { clientId, processId }).map(e => ({ ...e, clientName: clientMap.get(e.clientId) || '', processTitle: e.processId ? (processMap.get(e.processId) || '') : '' }));
    const summary = financialSummary(entries, { now: new Date(), timeZone: process.env.CJ_TIMEZONE || 'America/Asuncion' });
    return json(res, 200, { entries, summary }, requestId);
  }

  if (req.method === 'GET' && url.pathname === '/api/finance/summary') {
    requirePermission(session, 'finance:read');
    const db = await store.read();
    const entries = filterFinancialEntries(db.financialEntries, { clientId: url.searchParams.get('clientId'), processId: url.searchParams.get('processId') });
    return json(res, 200, { summary: financialSummary(entries, { now: new Date(), timeZone: process.env.CJ_TIMEZONE || 'America/Asuncion' }) }, requestId);
  }

  if (req.method === 'POST' && url.pathname === '/api/finance') {
    requirePermission(session, 'finance:write');
    const body = await readBody(req, 64 * 1024);
    const snapshot = await store.read();
    const validation = validateFinancialEntry(body, { clientIds: new Set(snapshot.clients.map(c => c.id)), processes: snapshot.processes });
    if (!validation.ok) return json(res, 400, { error: validation.error }, requestId);
    const now = new Date().toISOString();
    const entry = { id: newId('fin'), ...validation.value, createdBy: session.user.id, createdAt: now, updatedAt: now };
    const auditFields = { id: newId('audit'), action: 'CREATE', entity: 'financial-entry', entityId: entry.id, requestId, actor: { id: session.user.id, role: session.user.role }, detail: { clientId: entry.clientId, processId: entry.processId, direction: entry.direction, category: entry.category, amount: entry.amount, status: entry.status }, at: now };
    let result;
    if (store.supportsDedicatedFinancialEntries) {
      const rawKey = req.headers['idempotency-key'];
      result = rawKey ? await store.idempotentFinancialEntryCreate(rawKey, entry, auditFields) : await store.createDedicatedFinancialEntry(entry, auditFields);
    } else {
      result = await idempotentCreate(req, 'finance', async providedDb => {
        const createInto = async db => { db.financialEntries.unshift(entry); addAudit(db, session, requestId, 'CREATE', 'financial-entry', entry.id, auditFields.detail); return { entry }; };
        return providedDb ? createInto(providedDb) : store.mutate(createInto);
      });
    }
    return json(res, result.replayed ? 200 : 201, result, requestId);
  }

  const financeMatch = url.pathname.match(/^\/api\/finance\/([^/]+)$/);
  if (req.method === 'PATCH' && financeMatch) {
    requirePermission(session, 'finance:write');
    const body = await readBody(req, 64 * 1024);
    let result;
    if (store.supportsDedicatedFinancialEntries) {
      const current = await store.findFinancialEntryById(financeMatch[1]);
      if (!current) throw Object.assign(new Error('Lançamento financeiro não encontrado.'), { status: 404 });
      const db = await store.read();
      const validation = validateFinancialEntry({ ...current, ...body }, { clientIds: new Set(db.clients.map(c => c.id)), processes: db.processes });
      if (!validation.ok) throw Object.assign(new Error(validation.error), { status: 400 });
      const updated = { ...current, ...validation.value, updatedAt: new Date().toISOString() };
      const auditFields = { id: newId('audit'), action: 'UPDATE', entity: 'financial-entry', entityId: updated.id, requestId, actor: { id: session.user.id, role: session.user.role }, detail: { fields: Object.keys(body), direction: updated.direction, category: updated.category, status: updated.status }, at: updated.updatedAt };
      result = await store.updateDedicatedFinancialEntry(updated, auditFields);
    } else {
      result = await store.mutate(db => {
        const idx = db.financialEntries.findIndex(e => e.id === financeMatch[1]);
        if (idx < 0) throw Object.assign(new Error('Lançamento financeiro não encontrado.'), { status: 404 });
        const validation = validateFinancialEntry({ ...db.financialEntries[idx], ...body }, { clientIds: new Set(db.clients.map(c => c.id)), processes: db.processes });
        if (!validation.ok) throw Object.assign(new Error(validation.error), { status: 400 });
        const updated = { ...db.financialEntries[idx], ...validation.value, updatedAt: new Date().toISOString() }; db.financialEntries[idx] = updated;
        addAudit(db, session, requestId, 'UPDATE', 'financial-entry', updated.id, { fields: Object.keys(body), direction: updated.direction, category: updated.category, status: updated.status }); return updated;
      });
    }
    return json(res, 200, { entry: result }, requestId);
  }

  const processReportMatch = url.pathname.match(/^\/api\/reports\/process\/([^/]+)$/);
  if (req.method === 'GET' && processReportMatch) {
    requirePermission(session, 'reports:read');
    const db = await store.read();
    const report = processStatusReport(db, processReportMatch[1], { timeZone: process.env.CJ_TIMEZONE || 'America/Asuncion' });
    if (!hasPermission(session.user.role, 'finance:read')) delete report.finance;
    return json(res, 200, { report }, requestId);
  }

  const clientReportMatch = url.pathname.match(/^\/api\/reports\/client\/([^/]+)$/);
  if (req.method === 'GET' && clientReportMatch) {
    requirePermission(session, 'reports:read');
    const db = await store.read();
    const report = clientPortfolioReport(db, clientReportMatch[1], { timeZone: process.env.CJ_TIMEZONE || 'America/Asuncion' });
    if (!hasPermission(session.user.role, 'finance:read')) delete report.finance;
    return json(res, 200, { report }, requestId);
  }

  const clientCsvMatch = url.pathname.match(/^\/api\/reports\/client\/([^/]+)\/export$/);
  if (req.method === 'GET' && clientCsvMatch) {
    requirePermission(session, 'reports:read');
    if ((url.searchParams.get('format') || 'csv') !== 'csv') return json(res, 400, { error: 'Formato de exportação não suportado.' }, requestId);
    const db = await store.read();
    const report = clientPortfolioReport(db, clientCsvMatch[1], { timeZone: process.env.CJ_TIMEZONE || 'America/Asuncion' });
    const csv = clientPortfolioCsv(report);
    securityHeaders(res);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="cliente-${clientCsvMatch[1]}-processos.csv"`);
    res.setHeader('X-Request-Id', requestId);
    res.end(csv);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/agreements') {
    requirePermission(session, 'agreements:read');
    const db = await store.read();
    const processId = url.searchParams.get('processId');
    const processMap = new Map(db.processes.map(p => [p.id, p.title]));
    const source = store.supportsDedicatedAgreements ? await store.listAgreements() : db.agreements;
    const agreements = (processId ? source.filter(a => a.processId === processId) : source).map(a => ({ ...a, processTitle: processMap.get(a.processId) || '' }));
    return json(res, 200, { agreements }, requestId);
  }

  if (req.method === 'POST' && url.pathname === '/api/agreements') {
    requirePermission(session, 'agreements:write');
    const body = await readBody(req, 64 * 1024);
    const snapshot = await store.read();
    const validation = validateAgreement(body, new Set(snapshot.processes.map(p => p.id)));
    if (!validation.ok) return json(res, 400, { error: validation.error }, requestId);
    const now = new Date().toISOString();
    const agreement = { id: newId('agr'), ...validation.value, createdBy: session.user.id, createdAt: now, updatedAt: now };
    const auditFields = { id:`audit_${crypto.randomUUID()}`, action:'CREATE', entity:'agreement', entityId:agreement.id, requestId, actor:{id:session.user.id,role:session.user.role}, detail:{processId:agreement.processId,direction:agreement.direction,amount:agreement.amount,status:agreement.status}, at:now };
    let result;
    const rawKey = String(req.headers['idempotency-key'] || '').trim();
    if (store.supportsDedicatedAgreements) {
      result = rawKey ? await store.idempotentAgreementCreate(rawKey, agreement, auditFields) : await store.createDedicatedAgreement(agreement, auditFields);
    } else {
      result = await idempotentCreate(req, 'agreement', async providedDb => {
        const createInto = async db => { db.agreements.unshift(agreement); addAudit(db,session,requestId,'CREATE','agreement',agreement.id,auditFields.detail); return { agreement }; };
        return providedDb ? createInto(providedDb) : store.mutate(createInto);
      });
    }
    return json(res, result.replayed ? 200 : 201, result, requestId);
  }

  const agreementMatch = url.pathname.match(/^\/api\/agreements\/([^/]+)$/);
  if (req.method === 'PATCH' && agreementMatch) {
    requirePermission(session, 'agreements:write');
    const body = await readBody(req, 64 * 1024);
    if (store.supportsDedicatedAgreements) {
      const current = await store.findAgreementById(agreementMatch[1]);
      if (!current) throw Object.assign(new Error('Registro de acordo não encontrado.'), { status: 404 });
      const db = await store.read();
      const validation = validateAgreement({ ...current, ...body }, new Set(db.processes.map(p => p.id)));
      if (!validation.ok) throw Object.assign(new Error(validation.error), { status: 400 });
      const updated = { ...current, ...validation.value, updatedAt: new Date().toISOString() };
      await store.updateDedicatedAgreement(updated, { id:`audit_${crypto.randomUUID()}`, action:'UPDATE', entity:'agreement', entityId:updated.id, requestId, actor:{id:session.user.id,role:session.user.role}, detail:{fields:Object.keys(body),status:updated.status}, at:updated.updatedAt });
      return json(res, 200, { agreement: updated }, requestId);
    }
    const result = await store.mutate(db => {
      const idx = db.agreements.findIndex(a => a.id === agreementMatch[1]);
      if (idx < 0) throw Object.assign(new Error('Registro de acordo não encontrado.'), { status: 404 });
      const validation = validateAgreement({ ...db.agreements[idx], ...body }, new Set(db.processes.map(p => p.id)));
      if (!validation.ok) throw Object.assign(new Error(validation.error), { status: 400 });
      const updated = { ...db.agreements[idx], ...validation.value, updatedAt: new Date().toISOString() };
      db.agreements[idx] = updated;
      addAudit(db, session, requestId, 'UPDATE', 'agreement', updated.id, { fields: Object.keys(body), status: updated.status });
      return updated;
    });
    return json(res, 200, { agreement: result }, requestId);
  }

  if (req.method === 'GET' && url.pathname === '/api/executions') {
    requirePermission(session, 'executions:read');
    const db = await store.read();
    const processId = url.searchParams.get('processId');
    const processMap = new Map(db.processes.map(p => [p.id, p.title]));
    const source = store.supportsDedicatedExecutionActions ? await store.listExecutionActions() : db.executionActions;
    const actions = (processId ? source.filter(a => a.processId === processId) : source).map(a => ({ ...a, processTitle: processMap.get(a.processId) || '' }));
    const attention = executionAttention(actions, new Date(), process.env.CJ_TIMEZONE || 'America/Sao_Paulo');
    return json(res, 200, { executions: actions, attention }, requestId);
  }

  if (req.method === 'POST' && url.pathname === '/api/executions') {
    requirePermission(session, 'executions:write');
    const body = await readBody(req, 64 * 1024);
    const snapshot = await store.read();
    const validation = validateExecutionAction(body, new Set(snapshot.processes.map(p => p.id)));
    if (!validation.ok) return json(res, 400, { error: validation.error }, requestId);
    const now = new Date().toISOString();
    const action = { id: newId('exe'), ...validation.value, createdBy: session.user.id, createdAt: now, updatedAt: now };
    const auditFields={id:`audit_${crypto.randomUUID()}`,action:'CREATE',entity:'execution',entityId:action.id,requestId,actor:{id:session.user.id,role:session.user.role},detail:{processId:action.processId,measure:action.measure,status:action.status,reviewDate:action.reviewDate},at:now};
    let result; const rawKey=String(req.headers['idempotency-key']||'').trim();
    if(store.supportsDedicatedExecutionActions){result=rawKey?await store.idempotentExecutionActionCreate(rawKey,action,auditFields):await store.createDedicatedExecutionAction(action,auditFields);}
    else { result=await idempotentCreate(req,'execution',async providedDb=>{const createInto=async db=>{db.executionActions.unshift(action);addAudit(db,session,requestId,'CREATE','execution',action.id,auditFields.detail);return{execution:action}};return providedDb?createInto(providedDb):store.mutate(createInto)}); }
    return json(res, result.replayed ? 200 : 201, result, requestId);
  }

  const executionMatch = url.pathname.match(/^\/api\/executions\/([^/]+)$/);
  if (req.method === 'PATCH' && executionMatch) {
    requirePermission(session, 'executions:write');
    const body = await readBody(req, 64 * 1024);
    if(store.supportsDedicatedExecutionActions){
      const current=await store.findExecutionActionById(executionMatch[1]); if(!current)throw Object.assign(new Error('Medida executiva não encontrada.'),{status:404});
      const db=await store.read(); const validation=validateExecutionAction({...current,...body},new Set(db.processes.map(p=>p.id))); if(!validation.ok)throw Object.assign(new Error(validation.error),{status:400});
      const updated={...current,...validation.value,updatedAt:new Date().toISOString()}; await store.updateDedicatedExecutionAction(updated,{id:`audit_${crypto.randomUUID()}`,action:'UPDATE',entity:'execution',entityId:updated.id,requestId,actor:{id:session.user.id,role:session.user.role},detail:{fields:Object.keys(body),status:updated.status,measure:updated.measure},at:updated.updatedAt}); return json(res,200,{execution:updated},requestId);
    }
    const result = await store.mutate(db => {
      const idx = db.executionActions.findIndex(a => a.id === executionMatch[1]);
      if (idx < 0) throw Object.assign(new Error('Medida executiva não encontrada.'), { status: 404 });
      const validation = validateExecutionAction({ ...db.executionActions[idx], ...body }, new Set(db.processes.map(p => p.id)));
      if (!validation.ok) throw Object.assign(new Error(validation.error), { status: 400 });
      const updated = { ...db.executionActions[idx], ...validation.value, updatedAt: new Date().toISOString() };
      db.executionActions[idx] = updated;
      addAudit(db, session, requestId, 'UPDATE', 'execution', updated.id, { fields: Object.keys(body), status: updated.status, measure: updated.measure });
      return updated;
    });
    return json(res, 200, { execution: result }, requestId);
  }

  if (req.method === 'POST' && url.pathname === '/api/brief/daily') {
    requirePermission(session, 'dashboard:read');
    const body = await readBody(req, 32 * 1024);
    const includeGoogle = body.includeGoogle === true;
    let snapshot = { gmail: [], calendar: [], drive: [] };
    if (includeGoogle) {
      requirePermission(session, 'integrations:sync');
      if (!googleConfigured) return json(res, 503, { error: 'Google Workspace não configurado no servidor.' }, requestId);
      const google = new GoogleWorkspaceClient({ tokenProvider: googleTokenProvider });
      snapshot = await google.snapshot({ gmailQuery: normalizeText(body.gmailQuery, 500), maxGmail: body.maxGmail || 10, calendarDays: body.calendarDays || 7, maxDrive: 1 });
    }
    const db = await store.read();
    const clientMap = new Map(db.clients.map(c => [c.id, c.name]));
    const processes = db.processes.map(p => ({ ...p, clientName: clientMap.get(p.clientId) || '' }));
    const brief = buildDailyBrief({ processes, tasks: db.tasks, calendarEvents: snapshot.calendar, emailMetadata: snapshot.gmail, timeZone: process.env.CJ_TIMEZONE || 'America/Sao_Paulo' });
    if (includeGoogle) await store.mutate(state => addAudit(state, session, requestId, 'DAILY_BRIEF_GOOGLE_READ', 'brief', brief.date, { gmailCount: snapshot.gmail.length, calendarCount: snapshot.calendar.length, correlations: brief.emailCorrelations.length, persistedSnapshot: false }));
    return json(res, 200, { brief, external: { googleIncluded: includeGoogle, driveMetadataRead: false } }, requestId);
  }

  if (req.method === 'GET' && url.pathname === '/api/integrations/status') {
    requirePermission(session, 'integrations:read');
    return json(res, 200, {
      google: {
        configured: googleConfigured,
        enabled: googleEnabled,
        mode: 'read-only',
        authMode: googleAuthMode,
        features: ['gmail-metadata', 'calendar-events', 'drive-metadata'],
        persistence: 'snapshot-not-persisted'
      },
      openai: {
        configured: openaiConfigured,
        enabled: aiEnabled,
        model: openaiConfigured ? String(process.env.CJ_OPENAI_MODEL) : null,
        store: false,
        outputPolicy: 'human-review-required'
      }
    }, requestId);
  }

  if (req.method === 'POST' && url.pathname === '/api/integrations/google/snapshot') {
    requirePermission(session, 'integrations:sync');
    if (!googleConfigured) return json(res, 503, { error: 'Google Workspace não configurado no servidor.' }, requestId);
    const body = await readBody(req, 32 * 1024);
    const google = new GoogleWorkspaceClient({ tokenProvider: googleTokenProvider });
    const snapshot = await google.snapshot({
      gmailQuery: normalizeText(body.gmailQuery, 500),
      maxGmail: body.maxGmail,
      calendarDays: body.calendarDays,
      maxDrive: body.maxDrive
    });
    await store.mutate(db => addAudit(db, session, requestId, 'GOOGLE_READ_SNAPSHOT', 'integration', 'google-workspace', {
      gmailCount: snapshot.gmail.length,
      calendarCount: snapshot.calendar.length,
      driveCount: snapshot.drive.length,
      readOnly: true
    }));
    return json(res, 200, { snapshot }, requestId);
  }

  const aiDraftMatch = url.pathname.match(/^\/api\/processes\/([^/]+)\/ai\/draft$/);
  if (req.method === 'POST' && aiDraftMatch) {
    requirePermission(session, 'ai:draft');
    if (!openaiConfigured) return json(res, 503, { error: 'OpenAI não configurada no servidor.' }, requestId);
    const body = await readBody(req, 32 * 1024);
    if (body.confirmExternalProcessing !== true) return json(res, 400, { error: 'Confirmação explícita de processamento externo é obrigatória para gerar o rascunho.' }, requestId);
    const task = validateAiTask(body.task);
    const db = await store.read();
    const process = db.processes.find(p => p.id === aiDraftMatch[1]);
    if (!process) return json(res, 404, { error: 'Processo não encontrado.' }, requestId);
    const request = buildLegalDraftRequest(process, task);
    const client = new OpenAIResponsesClient();
    const result = await client.createDraft(request);
    await store.mutate(state => addAudit(state, session, requestId, 'AI_DRAFT_GENERATED', 'process', process.id, {
      provider: 'openai',
      model: result.model,
      responseId: result.id,
      task,
      inputChars: request.input.length,
      outputChars: result.text.length,
      storedExternallyByRequest: false,
      persistedLocally: false,
      humanReviewRequired: true
    }));
    return json(res, 200, { draft: publicDraft(result, task) }, requestId);
  }

  if (req.method === 'GET' && url.pathname === '/api/audit-log') {
    requirePermission(session, 'audit:read');
    const audit = await readAuditView();
    return json(res, 200, { auditLog: audit.auditLog.slice(0, 300) }, requestId);
  }

  return json(res, 404, { error: 'Endpoint não encontrado.' }, requestId);
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const safePath = path.normalize(requested).replace(/^([.][.][/\\])+/, '');
  const filePath = path.resolve(publicDir, `.${safePath}`);
  if (!filePath.startsWith(publicDir + path.sep) && filePath !== path.join(publicDir, 'index.html')) {
    securityHeaders(res); res.statusCode = 403; res.end('Forbidden'); return;
  }
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('not-file');
    const data = await fs.readFile(filePath);
    securityHeaders(res);
    res.statusCode = 200;
    res.setHeader('Content-Type', mime[path.extname(filePath)] || 'application/octet-stream');
    res.end(data);
  } catch {
    securityHeaders(res); res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end('Not found');
  }
}

export default async function handler(req, res) {
  const requestId = crypto.randomUUID();
  const started = Date.now();
  try {
    const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
    if (!url.pathname.startsWith('/api/')) {
      if (process.env.CJ_SERVE_STATIC_FROM_FUNCTION === 'true') return serveStatic(req, res, url);
      return json(res, 404, { error: 'Endpoint não encontrado.' }, requestId);
    }
    await handleApi(req, res, url, requestId);
  } catch (error) {
    const status = Number(error.status) || 500;
    console.error(JSON.stringify({ level: status >= 500 ? 'error' : 'warn', requestId, method: req.method, url: req.url, status, message: error.message }));
    if (!res.headersSent) json(res, status, { error: status === 500 ? 'Erro interno.' : error.message, requestId }, requestId);
    else res.end();
  } finally {
    console.log(JSON.stringify({ level: 'info', requestId, method: req.method, url: req.url, status: res.statusCode, ms: Date.now() - started }));
  }
}
