import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { PostgresRateLimiter, hashRateLimitKey } from '../src/rate-limit-v1-7.mjs';
import { resolveClientIp } from '../src/client-ip-v1-7.mjs';

if(!process.env.CJ_DATABASE_URL){console.error(JSON.stringify({ok:false,error:'CJ_DATABASE_URL ausente'}));process.exit(2);}
const runId=crypto.randomUUID();const startedAt=new Date().toISOString();const evidence={runId,startedAt,phases:[]};const phase=(name,detail={})=>evidence.phases.push({name,ok:true,...detail});
const pool=new pg.Pool({connectionString:process.env.CJ_DATABASE_URL,max:30,connectionTimeoutMillis:5000,idleTimeoutMillis:5000,statement_timeout:15000,application_name:'central-juridica-ci-gate-v1-7-rate-limit'});
try{
  const version=await pool.query('SELECT version() AS version');phase('postgres-connectivity',{version:version.rows[0].version});
  const limiter=new PostgresRateLimiter(pool);await limiter.ensure();phase('rate-limit-schema-ready');
  const rawIp='198.51.100.77';const rateKey=hashRateLimitKey('login-ip',rawIp);assert.equal(rateKey.includes(rawIp),false);phase('rate-key-hashed',{prefix:rateKey.slice(0,9)});
  const now=Date.now();const attempts=await Promise.all(Array.from({length:25},()=>limiter.consume(rateKey,{limit:10,windowMs:900000,now})));
  const row=await pool.query('SELECT count, reset_at FROM central_juridica_rate_limits WHERE rate_key=$1',[rateKey]);assert.equal(Number(row.rows[0].count),25);assert.equal(attempts.filter(a=>a.allowed).length,10);assert.equal(Math.max(...attempts.map(a=>a.count)),25);phase('rate-limit-concurrency',{writers:25,persisted:25,allowed:10,lostIncrements:0});
  await limiter.reset(rateKey);assert.equal((await pool.query('SELECT count FROM central_juridica_rate_limits WHERE rate_key=$1',[rateKey])).rows.length,0);phase('rate-limit-reset');
  const expiryKey=hashRateLimitKey('login-ip','198.51.100.78');await limiter.consume(expiryKey,{limit:10,windowMs:1000,now:1000});const afterExpiry=await limiter.consume(expiryKey,{limit:10,windowMs:1000,now:2001});assert.equal(afterExpiry.count,1);phase('rate-limit-window-reset');
  const trusted=['10.0.0.0/8','192.168.0.0/16'];assert.equal(resolveClientIp('203.0.113.9','1.2.3.4',trusted),'203.0.113.9');phase('spoofed-forwarded-for-ignored-untrusted-peer');
  assert.equal(resolveClientIp('10.0.0.2','198.51.100.7, 192.168.1.4',trusted),'198.51.100.7');phase('trusted-proxy-chain-resolved');
  assert.equal(resolveClientIp('10.0.0.2','198.51.100.7, attacker',trusted),'10.0.0.2');phase('malformed-forwarded-for-fail-closed');
  evidence.finishedAt=new Date().toISOString();evidence.summary={postgresSharedLimiter:true,writers:25,persisted:25,allowedBeforeBlock:10,lostIncrements:0,hashedIdentifiers:true,untrustedSpoofIgnored:true,trustedProxyChain:true,malformedHeaderFailClosed:true};console.log(JSON.stringify({ok:true,evidence},null,2));
}catch(error){evidence.finishedAt=new Date().toISOString();console.error(JSON.stringify({ok:false,evidence,error:{name:error.name,message:error.message,stack:error.stack}},null,2));process.exitCode=1;}finally{try{await pool.query("DELETE FROM central_juridica_rate_limits WHERE rate_key LIKE 'login-%'");}catch{}await pool.end();}
