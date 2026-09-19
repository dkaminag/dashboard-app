export const BASE_GATES = Object.freeze({
  staticCheck: 'approved',
  localTests: 'approved',
  postgresConcurrency: 'approved',
  rollback: 'approved',
  backupCryptoCode: 'approved',
  documentEncryption: 'approved',
  originProtection: 'approved',
  securityHeaders: 'approved',
  financialRealizedVsProjected: 'approved',
  preventiveDeterministicScoring: 'approved',
  evidenceMetadataOnly: 'approved',
  evidenceHumanReview: 'approved',
  auditEntryHmac: 'approved',
  auditMetadataHmac: 'approved',
  mfaTotp: 'approved',
  keyringRotationCode: 'approved',
  requestSecurityProxyAndRateLimit: 'approved',
  dedicatedPostgresSessions: 'approved',
  dedicatedPostgresUsers: 'approved',
  dedicatedPostgresAudit: 'approved',
  dedicatedPostgresIdempotency: 'approved'
});

function hasAudit(db, action) {
  return Array.isArray(db?.auditLog) && db.auditLog.some(entry => entry.action === action);
}

export function evaluateAuditGates({ db = {}, googleEnabled = false, googleConfigured = false, openaiEnabled = false, openaiConfigured = false, coreRuntimeReady = false, version = 'unknown' } = {}) {
  const googleLive = !googleEnabled ? 'disabled' : hasAudit(db, 'GOOGLE_READ_SNAPSHOT') || hasAudit(db, 'DAILY_BRIEF_GOOGLE_READ') ? 'approved' : googleConfigured ? 'configured_not_live_verified' : 'pending_credentials';
  const openAiLive = !openaiEnabled ? 'disabled' : hasAudit(db, 'AI_DRAFT_GENERATED') ? 'approved' : openaiConfigured ? 'configured_not_live_verified' : 'pending_credentials';
  const backupCreated = hasAudit(db, 'BACKUP_CREATED_VERIFIED');
  const backupRestored = hasAudit(db, 'BACKUP_RESTORE_VERIFIED');
  const backupRestoreLive = backupCreated && backupRestored ? 'approved' : backupCreated ? 'backup_verified_restore_pending' : 'pending_runtime_evidence';
  const integrationsReady = googleLive === 'approved' && openAiLive === 'approved';
  const backupReady = backupRestoreLive === 'approved';
  const fullProductionReady = Boolean(coreRuntimeReady && integrationsReady && backupReady);
  const decision = fullProductionReady ? 'PRODUCTION_READY' : coreRuntimeReady ? 'CORE_PRODUCTION_READY_EXTERNAL_GATES_PENDING' : 'READY_FOR_CONTROLLED_INTERNAL_PILOT';
  let nextGate = 'Executar no runtime definitivo com PostgreSQL, HTTPS e cookies seguros.';
  if (coreRuntimeReady && !backupReady) nextGate = 'Executar backup criptografado e restore real no ambiente definitivo e registrar evidências.';
  else if (coreRuntimeReady && googleLive !== 'approved') nextGate = 'Executar uma leitura Google metadata/readonly real e registrar evidência.';
  else if (coreRuntimeReady && openAiLive !== 'approved') nextGate = 'Executar um rascunho OpenAI real com consentimento e revisão humana.';
  else if (fullProductionReady) nextGate = 'Manter backups, rotação de chaves e auditoria recorrente.';
  return { version, fullProductionReady, coreRuntimeReady, integrationsReady, backupReady, decision, gates: { ...BASE_GATES, backupRestoreLive, googleLive, openAiLive }, nextGate };
}
