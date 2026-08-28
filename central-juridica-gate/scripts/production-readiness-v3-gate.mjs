import pg from 'pg';
import { evaluateRuntimeReadiness, REQUIRED_CAPABILITIES } from '../src/runtime-readiness-v3.mjs';
const url=process.env.CJ_DATABASE_URL;if(!url)throw new Error('CJ_DATABASE_URL ausente.');
const pool=new pg.Pool({connectionString:url,max:10});
const expected={sessions:'central_juridica_sessions',users:'central_juridica_users',audit:'central_juridica_audit_log',idempotency:'central_juridica_idempotency',tasks:'central_juridica_tasks',processes:'central_juridica_processes',agreements:'central_juridica_agreements',executionActions:'central_juridica_execution_actions',financialEntries:'central_juridica_financial_entries',preventiveAssessments:'central_juridica_preventive_assessments',externalEvidence:'central_juridica_external_evidence',clients:'central_juridica_clients',documents:'central_juridica_documents',documentBlobs:'central_juridica_document_blobs',sharedRateLimit:'central_juridica_rate_limits'};
try{
 const version=(await pool.query('select version() version')).rows[0].version;
 const tables=(await pool.query("select tablename from pg_tables where schemaname='public' and tablename like 'central_juridica_%' order by tablename")).rows.map(r=>r.tablename);
 const set=new Set(tables);const capabilities={};for(const name of REQUIRED_CAPABILITIES)capabilities[name]=name==='atomicSnapshot'?true:set.has(expected[name]);
 const runtime=evaluateRuntimeReadiness({production:true,postgres:true,documentStoragePostgres:true,documentKeyring:true,backupKeyring:true,secureCookie:true,mfaPolicyCompliant:true,requestSecurity:true,auditIntegrity:true,capabilities});
 if(!runtime.ready)throw new Error(`PRODUCTION_READINESS_FAILED:${runtime.missing.join(',')}`);
 const state=(await pool.query("select state from central_juridica_state where singleton=true")).rows[0]?.state||{};
 const normalizedKeys=['users','clients','documents','tasks','processes','agreements','executionActions','financialEntries','preventiveAssessments','externalEvidence'];
 const residual=normalizedKeys.filter(k=>state[k]!=null&&(!Array.isArray(state[k])||state[k].length!==0));
 if(residual.length)throw new Error(`NORMALIZED_DOMAIN_STILL_PRESENT_IN_JSONB:${residual.join(',')}`);
 console.log(JSON.stringify({ok:true,evidence:{postgresVersion:version,requiredCapabilities:REQUIRED_CAPABILITIES.length,allCapabilitiesReady:true,normalizedDomainOutsideJsonb:true,normalizedKeys,runtime}},null,2));
}catch(error){console.error(JSON.stringify({ok:false,error:{message:error.message,stack:error.stack}},null,2));process.exitCode=1;}finally{await pool.end();}
