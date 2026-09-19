import { GoogleTokenProvider } from './google-auth.mjs';
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1';
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';

export class GoogleWorkspaceClient {
  constructor({ accessToken, tokenProvider, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.tokenProvider = tokenProvider || new GoogleTokenProvider({ accessToken, fetchImpl, timeoutMs });
  }

  get configured() { return this.tokenProvider.configured; }

  assertConfigured() {
    if (!this.configured) throw Object.assign(new Error('Google Workspace não configurado.'), { status: 503, code: 'GOOGLE_NOT_CONFIGURED' });
  }

  async listGmailMetadata({ query = '', maxResults = 10 } = {}) {
    this.assertConfigured();
    const limit = clamp(maxResults, 1, 25, 10);
    const params = new URLSearchParams({ maxResults: String(limit) });
    if (query) params.set('q', String(query).slice(0, 500));
    const list = await this.#json(`${GMAIL_BASE}/users/me/messages?${params}`);
    const messages = Array.isArray(list.messages) ? list.messages.slice(0, limit) : [];
    const rows = await Promise.all(messages.map(async item => {
      const detailParams = new URLSearchParams({ format: 'metadata' });
      for (const header of ['Subject', 'From', 'Date']) detailParams.append('metadataHeaders', header);
      const detail = await this.#json(`${GMAIL_BASE}/users/me/messages/${encodeURIComponent(item.id)}?${detailParams}`);
      const headers = Object.fromEntries((detail.payload?.headers || []).map(h => [String(h.name || '').toLowerCase(), String(h.value || '')]));
      return {
        id: detail.id,
        threadId: detail.threadId,
        subject: headers.subject || '(sem assunto)',
        from: headers.from || '',
        date: headers.date || '',
        labelIds: Array.isArray(detail.labelIds) ? detail.labelIds : []
      };
    }));
    return rows;
  }

  async listCalendarEvents({ timeMin = new Date().toISOString(), timeMax, maxResults = 25 } = {}) {
    this.assertConfigured();
    const params = new URLSearchParams({
      singleEvents: 'true', orderBy: 'startTime', timeMin: new Date(timeMin).toISOString(), maxResults: String(clamp(maxResults, 1, 100, 25))
    });
    if (timeMax) params.set('timeMax', new Date(timeMax).toISOString());
    const data = await this.#json(`${CALENDAR_BASE}/calendars/primary/events?${params}`);
    return (data.items || []).map(event => ({
      id: event.id,
      summary: event.summary || '(sem título)',
      start: event.start?.dateTime || event.start?.date || null,
      end: event.end?.dateTime || event.end?.date || null,
      status: event.status || null,
      htmlLink: event.htmlLink || null
    }));
  }

  async listDriveFiles({ pageSize = 25 } = {}) {
    this.assertConfigured();
    const params = new URLSearchParams({
      q: 'trashed = false',
      pageSize: String(clamp(pageSize, 1, 100, 25)),
      orderBy: 'modifiedTime desc',
      fields: 'files(id,name,mimeType,modifiedTime,webViewLink)'
    });
    const data = await this.#json(`${DRIVE_BASE}/files?${params}`);
    return (data.files || []).map(file => ({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      modifiedTime: file.modifiedTime || null,
      webViewLink: file.webViewLink || null
    }));
  }

  async snapshot({ gmailQuery = '', maxGmail = 10, calendarDays = 14, maxDrive = 25 } = {}) {
    const now = new Date();
    const end = new Date(now.getTime() + clamp(calendarDays, 1, 90, 14) * 86400000);
    const [gmail, calendar, drive] = await Promise.all([
      this.listGmailMetadata({ query: gmailQuery, maxResults: maxGmail }),
      this.listCalendarEvents({ timeMin: now.toISOString(), timeMax: end.toISOString() }),
      this.listDriveFiles({ pageSize: maxDrive })
    ]);
    return { gmail, calendar, drive, generatedAt: new Date().toISOString(), readOnly: true };
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
      const message = data?.error?.message || `Google API retornou HTTP ${response.status}.`;
      throw Object.assign(new Error(String(message).slice(0, 500)), { status: response.status === 401 || response.status === 403 ? 502 : 503, upstreamStatus: response.status });
    }
    return data;
  }
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}
