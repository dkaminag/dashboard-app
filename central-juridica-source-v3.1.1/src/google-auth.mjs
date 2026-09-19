const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export class GoogleTokenProvider {
  constructor({
    accessToken = process.env.CJ_GOOGLE_ACCESS_TOKEN,
    refreshToken = process.env.CJ_GOOGLE_REFRESH_TOKEN,
    clientId = process.env.CJ_GOOGLE_CLIENT_ID,
    clientSecret = process.env.CJ_GOOGLE_CLIENT_SECRET,
    fetchImpl = globalThis.fetch,
    timeoutMs = 10_000
  } = {}) {
    this.staticAccessToken = String(accessToken || '').trim();
    this.refreshToken = String(refreshToken || '').trim();
    this.clientId = String(clientId || '').trim();
    this.clientSecret = String(clientSecret || '').trim();
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.cached = null;
  }

  get refreshConfigured() { return Boolean(this.refreshToken && this.clientId && this.clientSecret); }
  get configured() { return this.refreshConfigured || Boolean(this.staticAccessToken); }
  get mode() { return this.refreshConfigured ? 'refresh-token' : this.staticAccessToken ? 'access-token' : 'not-configured'; }

  async getAccessToken() {
    if (this.refreshConfigured) {
      if (this.cached && this.cached.expiresAt > Date.now() + 60_000) return this.cached.token;
      return this.#refresh();
    }
    if (this.staticAccessToken) return this.staticAccessToken;
    throw Object.assign(new Error('Google OAuth não configurado.'), { status: 503, code: 'GOOGLE_NOT_CONFIGURED' });
  }

  async #refresh() {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
      grant_type: 'refresh_token'
    });
    const response = await this.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok || !data.access_token) {
      const message = data?.error_description || data?.error || `Google OAuth retornou HTTP ${response.status}.`;
      throw Object.assign(new Error(String(message).slice(0, 400)), { status: 503, upstreamStatus: response.status });
    }
    const expiresIn = Math.max(60, Number(data.expires_in) || 3600);
    this.cached = { token: String(data.access_token), expiresAt: Date.now() + expiresIn * 1000 };
    return this.cached.token;
  }
}
