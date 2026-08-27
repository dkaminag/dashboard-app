export function emptyState() {
  return { version: 3, users: [], sessions: [], clients: [], processes: [], tasks: [], documents: [], integrations: [], oauthStates: [], aiRuns: [], auditLog: [], idempotency: {} };
}

export function normalizeState(parsed = {}) {
  return {
    version: 3,
    users: Array.isArray(parsed.users) ? parsed.users : [],
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    clients: Array.isArray(parsed.clients) ? parsed.clients : [],
    processes: Array.isArray(parsed.processes) ? parsed.processes : [],
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    documents: Array.isArray(parsed.documents) ? parsed.documents : [],
    integrations: Array.isArray(parsed.integrations) ? parsed.integrations : [],
    oauthStates: Array.isArray(parsed.oauthStates) ? parsed.oauthStates : [],
    aiRuns: Array.isArray(parsed.aiRuns) ? parsed.aiRuns : [],
    auditLog: Array.isArray(parsed.auditLog) ? parsed.auditLog : [],
    idempotency: parsed.idempotency && typeof parsed.idempotency === 'object' ? parsed.idempotency : {}
  };
}
