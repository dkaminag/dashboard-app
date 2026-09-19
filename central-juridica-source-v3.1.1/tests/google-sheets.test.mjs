import test from 'node:test';
import assert from 'node:assert/strict';
import { CentralJuridicaSheetClient, CENTRAL_SHEET_TABS, DEFAULT_CENTRAL_SHEET_ID } from '../src/google-sheets.mjs';

function jsonResponse(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}})}
function tokenProvider(token='test-access-token'){return{configured:true,async getAccessToken(){return token}}}

test('Sheets usa somente GET em range autorizado e converte linhas',async()=>{
  const calls=[];
  const fake=async(url,options={})=>{calls.push({url:String(url),options});assert.equal(options.method,'GET');return jsonResponse({spreadsheetId:DEFAULT_CENTRAL_SHEET_ID,valueRanges:[{values:[['ID','Status','Status'],['1','Ativo','Gate'],['','',''],['2','Pendente','OK']]}]})};
  const client=new CentralJuridicaSheetClient({tokenProvider:tokenProvider(),fetchImpl:fake});
  const result=await client.readTabs({tabs:['Processos'],limit:50});
  assert.equal(result.readOnly,true);assert.equal(result.persisted,false);assert.equal(result.tabs[0].rowCount,2);
  assert.equal(result.tabs[0].records[0].Status,'Ativo');assert.equal(result.tabs[0].records[0].Status__2,'Gate');
  assert.match(decodeURIComponent(calls[0].url),/"?'?Processos'?\!A1:BX51/);
});

test('Sheets rejeita aba fora da whitelist antes de chamar Google',async()=>{
  let calls=0; const client=new CentralJuridicaSheetClient({tokenProvider:tokenProvider(),fetchImpl:async()=>{calls++;return jsonResponse({})}});
  await assert.rejects(()=>client.readTabs({tabs:['Segredos']}),e=>e?.code==='CENTRAL_SHEET_TAB_NOT_ALLOWED');assert.equal(calls,0);
});

test('Sheets limita leitura a 1000 linhas e 6 abas',async()=>{
  const fake=async(url)=>{const u=new URL(String(url));const ranges=u.searchParams.getAll('ranges');assert.equal(ranges.length,6);assert.ok(ranges.every(x=>/1001$/.test(x)));return jsonResponse({valueRanges:ranges.map(()=>({values:[['H']]}))})};
  const client=new CentralJuridicaSheetClient({tokenProvider:tokenProvider(),fetchImpl:fake});
  const result=await client.readTabs({tabs:Object.keys(CENTRAL_SHEET_TABS).slice(0,8),limit:99999});assert.equal(result.tabs.length,6);
});

test('403 vira erro de escopo sanitizado',async()=>{
  const client=new CentralJuridicaSheetClient({tokenProvider:tokenProvider(),fetchImpl:async()=>jsonResponse({error:{message:'provider-secret-detail'}},403)});
  await assert.rejects(()=>client.metadata(),e=>{assert.equal(e.code,'GOOGLE_SHEETS_SCOPE_REQUIRED');assert.match(e.message,/spreadsheets\.readonly/);assert.equal(e.message.includes('provider-secret-detail'),false);return true});
});
