import { GoogleTokenProvider } from './google-auth.mjs';

const SHEETS_BASE = 'https://sheets.googleapis.com/v4';
export const DEFAULT_CENTRAL_SHEET_ID = '1ulpnyfOP2vhOSQIqjO43DnQZw06FODZ6erx8H92Wc_E';

export const CENTRAL_SHEET_TABS = Object.freeze({
  Processos: 'BX',
  Execucoes: 'Z',
  Prazos_Audiencias: 'AB',
  Pendencias_Docs: 'AF',
  Consultivo_Clientes: 'Z',
  Biblioteca_Teses: 'Z',
  Inbox_Juridica: 'P',
  Publicacoes: 'S',
  Matriz_Execucoes: 'T',
  Cobrancas_Fluxo: 'AF',
  Producao_Pecas: 'AL',
  Auditoria_Pecas: 'Q',
  Matriz_Alegacoes_Provas: 'Y',
  Conferencia_Documental: 'R',
  Prioridade_Diaria: 'AE',
  Fila_Desbloqueio: 'V',
  Followup_Contatos: 'H',
  Controle_Automacao: 'T'
});

export const GOOGLE_SHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

export class CentralJuridicaSheetClient {
  constructor({
    spreadsheetId = process.env.CJ_CENTRAL_SHEET_ID || DEFAULT_CENTRAL_SHEET_ID,
    tokenProvider,
    accessToken,
    fetchImpl = globalThis.fetch,
    timeoutMs = 12_000
  } = {}) {
    this.spreadsheetId = String(spreadsheetId || '').trim();
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.tokenProvider = tokenProvider || new GoogleTokenProvider({ accessToken, fetchImpl, timeoutMs });
  }

  get configured() { return Boolean(this.spreadsheetId && this.tokenProvider.configured); }
  get allowedTabs() { return Object.keys(CENTRAL_SHEET_TABS); }

  assertConfigured() {
    if (!this.spreadsheetId) throw Object.assign(new Error('Planilha Central Jurídica não configurada.'), { status: 503, code: 'CENTRAL_SHEET_NOT_CONFIGURED' });
    if (!this.tokenProvider.configured) throw Object.assign(new Error('Google OAuth não configurado.'), { status: 503, code: 'GOOGLE_NOT_CONFIGURED' });
  }

  async metadata() {
    this.assertConfigured();
    const fields = 'spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount)))';
    const data = await this.#json(`${SHEETS_BASE}/spreadsheets/${encodeURIComponent(this.spreadsheetId)}?fields=${encodeURIComponent(fields)}`);
    const sheets = (data.sheets || []).map(s => ({
      sheetId: s?.properties?.sheetId ?? null,
      title: String(s?.properties?.title || ''),
      index: Number(s?.properties?.index ?? 0),
      hidden: Boolean(s?.properties?.hidden),
      rowCount: Number(s?.properties?.gridProperties?.rowCount || 0),
      columnCount: Number(s?.properties?.gridProperties?.columnCount || 0)
    })).filter(s => s.title);
    return {
      title: String(data?.properties?.title || ''),
      locale: String(data?.properties?.locale || ''),
      timeZone: String(data?.properties?.timeZone || ''),
      sheets,
      allowedTabs: sheets.filter(s => this.allowedTabs.includes(s.title)).map(s => s.title),
      readOnly: true
    };
  }

  async readTabs({ tabs = ['Processos'], limit = 100 } = {}) {
    this.assertConfigured();
    const safeLimit = clamp(limit, 1, 1000, 100);
    const safeTabs = normalizeTabs(tabs);
    if (!safeTabs.length) throw Object.assign(new Error('Informe ao menos uma aba permitida.'), { status: 400, code: 'CENTRAL_SHEET_TAB_REQUIRED' });

    const params = new URLSearchParams({
      majorDimension: 'ROWS',
      valueRenderOption: 'FORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING'
    });
    for (const tab of safeTabs) {
      const endColumn = CENTRAL_SHEET_TABS[tab];
      params.append('ranges', `${quoteSheet(tab)}!A1:${endColumn}${safeLimit + 1}`);
    }
    const data = await this.#json(`${SHEETS_BASE}/spreadsheets/${encodeURIComponent(this.spreadsheetId)}/values:batchGet?${params}`);
    const valueRanges = Array.isArray(data.valueRanges) ? data.valueRanges : [];
    const results = safeTabs.map((tab, index) => {
      const rows = Array.isArray(valueRanges[index]?.values) ? valueRanges[index].values : [];
      return rowsToRecords(tab, rows, safeLimit);
    });
    return {
      generatedAt: new Date().toISOString(),
      readOnly: true,
      persisted: false,
      tabs: results
    };
  }

  async #json(url) {
    const accessToken = await this.tokenProvider.getAccessToken();
    const response = await this.fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) {
      const upstream = data?.error?.message || `Google Sheets API retornou HTTP ${response.status}.`;
      const missingScope = response.status === 403;
      const message = missingScope
        ? 'Google Sheets sem autorização de leitura. Reautorize a conta Google com o escopo spreadsheets.readonly.'
        : String(upstream).slice(0, 500);
      throw Object.assign(new Error(message), {
        status: response.status === 401 || response.status === 403 ? 502 : 503,
        upstreamStatus: response.status,
        code: missingScope ? 'GOOGLE_SHEETS_SCOPE_REQUIRED' : 'GOOGLE_SHEETS_UPSTREAM_ERROR'
      });
    }
    return data;
  }
}

function normalizeTabs(input) {
  const raw = Array.isArray(input) ? input : [input];
  const out = [];
  for (const value of raw) {
    const tab = String(value || '').trim();
    if (!tab) continue;
    if (!Object.prototype.hasOwnProperty.call(CENTRAL_SHEET_TABS, tab)) {
      throw Object.assign(new Error(`Aba não autorizada: ${tab}.`), { status: 400, code: 'CENTRAL_SHEET_TAB_NOT_ALLOWED' });
    }
    if (!out.includes(tab)) out.push(tab);
  }
  return out.slice(0, 6);
}

function rowsToRecords(tab, rows, limit) {
  const headerRow = Array.isArray(rows[0]) ? rows[0] : [];
  const headers = uniqueHeaders(headerRow);
  const records = [];
  for (let i = 1; i < rows.length && records.length < limit; i++) {
    const row = Array.isArray(rows[i]) ? rows[i] : [];
    if (!row.some(v => String(v ?? '').trim() !== '')) continue;
    const record = { _row: i + 1 };
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      if (!key) continue;
      const value = row[c] ?? '';
      if (value !== '') record[key] = value;
    }
    records.push(record);
  }
  return { tab, headers: headers.filter(Boolean), rowCount: records.length, records };
}

function uniqueHeaders(row) {
  const seen = new Map();
  return row.map((raw, idx) => {
    const base = String(raw || '').trim() || `COL_${idx + 1}`;
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}__${count}`;
  });
}

function quoteSheet(name) {
  return `'${String(name).replaceAll("'", "''")}'`;
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}
