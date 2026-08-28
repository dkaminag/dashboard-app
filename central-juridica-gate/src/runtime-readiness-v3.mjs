export const REQUIRED_CAPABILITIES = Object.freeze(['sessions','users','audit','idempotency','tasks','processes','agreements','executionActions','financialEntries','preventiveAssessments','externalEvidence','clients','documents','documentBlobs','atomicSnapshot','sharedRateLimit']);
export function evaluateRuntimeReadiness({production=false,postgres=false,documentStoragePostgres=false,documentKeyring=false,backupKeyring=false,secureCookie=false,mfaPolicyCompliant=false,requestSecurity=false,auditIntegrity=false,capabilities={}}={}){
  const normalizedPostgres=REQUIRED_CAPABILITIES.every(name=>capabilities[name]===true);
  const checks={productionEnvironment:Boolean(production),postgresBackend:Boolean(postgres),normalizedPostgres,postgresDocumentStorage:Boolean(documentStoragePostgres),documentKeyring:Boolean(documentKeyring),backupKeyring:Boolean(backupKeyring),secureCookie:Boolean(secureCookie),mfaPolicyCompliant:Boolean(mfaPolicyCompliant),requestSecurity:Boolean(requestSecurity),auditIntegrity:Boolean(auditIntegrity)};
  const missing=Object.entries(checks).filter(([,ok])=>!ok).map(([name])=>name);
  return{ready:missing.length===0,checks,capabilities,missing};
}
