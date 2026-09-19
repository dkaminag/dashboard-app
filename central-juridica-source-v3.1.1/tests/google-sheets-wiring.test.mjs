import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('servidor v3 expõe somente leitura para a planilha central',async()=>{
  const server=await fs.readFile(new URL('../src/server.mjs',import.meta.url),'utf8');
  assert.match(server,/CentralJuridicaSheetClient/);
  assert.match(server,/\/api\/integrations\/google\/central-sheet\/status/);
  assert.match(server,/\/api\/integrations\/google\/central-sheet\/read/);
  assert.match(server,/GOOGLE_CENTRAL_SHEET_READ/);
  assert.match(server,/persistedSnapshot:\s*false/);
});

test('UI v3 oferece teste e leitura sem edição',async()=>{
  const ui=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
  assert.match(ui,/testCentralSheet/);assert.match(ui,/readCentralSheet/);
  assert.match(ui,/somente leitura/i);
  assert.doesNotMatch(ui,/central-sheet\/(write|update|append|delete)/i);
});

test('cliente Google Sheets nunca envia método de escrita',async()=>{
  const mod=await fs.readFile(new URL('../src/google-sheets.mjs',import.meta.url),'utf8');
  assert.match(mod,/method:\s*'GET'/);
  assert.doesNotMatch(mod,/method:\s*'(POST|PUT|PATCH|DELETE)'/);
});
