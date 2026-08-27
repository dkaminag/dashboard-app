export function emptyState() {
  return { version: 4, users: [], sessions: [], clients: [], processes: [], tasks: [], documents: [], agreements: [], executionActions: [], financialEntries: [], auditLog: [], idempotency: {} };
}

export function normalizeState(parsed = {}) {
  return {
    version: 4,
    users: Array.isArray(parsed.users) ? parsed.users : [],
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    clients: Array.isArray(parsed.clients) ? parsed.clients : [],
    processes: Array.isArray(parsed.processes) ? parsed.processes : [],
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    documents: Array.isArray(parsed.documents) ? parsed.documents : [],
    agreements: Array.isArray(parsed.agreements) ? parsed.agreements : [],
    executionActions: Array.isArray(parsed.executionActions) ? parsed.executionActions : [],
    financialEntries: Array.isArray(parsed.financialEntries) ? parsed.financialEntries : [],
    auditLog: Array.isArray(parsed.auditLog) ? parsed.auditLog : [],
    idempotency: parsed.idempotency && typeof parsed.idempotency === 'object' ? parsed.idempotency : {}
  };
}
