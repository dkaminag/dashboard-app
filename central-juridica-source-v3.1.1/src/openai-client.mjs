const RESPONSES_URL = 'https://api.openai.com/v1/responses';

export class OpenAIResponsesClient {
  constructor({ apiKey = process.env.CJ_OPENAI_API_KEY, model = process.env.CJ_OPENAI_MODEL, fetchImpl = globalThis.fetch, timeoutMs = 45_000 } = {}) {
    this.apiKey = String(apiKey || '').trim();
    this.model = String(model || '').trim();
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  get configured() { return Boolean(this.apiKey && this.model); }

  assertConfigured() {
    if (!this.apiKey) throw Object.assign(new Error('OpenAI não configurada: CJ_OPENAI_API_KEY ausente.'), { status: 503, code: 'OPENAI_NOT_CONFIGURED' });
    if (!this.model) throw Object.assign(new Error('OpenAI não configurada: CJ_OPENAI_MODEL ausente.'), { status: 503, code: 'OPENAI_MODEL_NOT_CONFIGURED' });
  }

  async createDraft({ instructions, input, maxOutputTokens = 2500 }) {
    this.assertConfigured();
    const response = await this.fetch(RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        model: this.model,
        store: false,
        instructions: String(instructions || '').slice(0, 20_000),
        input: String(input || '').slice(0, 40_000),
        max_output_tokens: Math.min(5000, Math.max(300, Number(maxOutputTokens) || 2500))
      }),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) {
      const message = data?.error?.message || `OpenAI retornou HTTP ${response.status}.`;
      throw Object.assign(new Error(String(message).slice(0, 500)), { status: response.status === 401 || response.status === 403 ? 502 : 503, upstreamStatus: response.status });
    }
    const text = extractOutputText(data);
    if (!text) throw Object.assign(new Error('Resposta da IA sem texto utilizável.'), { status: 502 });
    return { id: data.id || null, model: data.model || this.model, text };
  }
}

export function extractOutputText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  const parts = [];
  for (const output of data?.output || []) {
    for (const content of output?.content || []) {
      if ((content?.type === 'output_text' || content?.type === 'text') && typeof content.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('\n').trim();
}
