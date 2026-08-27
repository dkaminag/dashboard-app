export function emptyState() {
  return { version: 5, users: [], sessions: [], clients: [], processes: [], tasks: [], documents: [], agreements: [], executionActions: [], financialEntries: [], preventiveAssessments: [], auditLog: [], idempotency: {} };
}

export function normalizeState(parsed = {}) {
  return {
    version: 5,
    users: Array.isArray(parsed.users) ? parsed.users : [],
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    clients: Array.isArray(parsed.clients) ? parsed.clients : [],
    processes: Array.isArray(parsed.processes) ? parsed.processes : [],
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    documents: Array.isArray(parsed.documents) ? parsed.documents : [],
    agreements: Array.isArray(parsed.agreements) ? parsed.agreements : [],
    executionActions: Array.isArray(parsed.executionActions) ? parsed.executionActions : [],
    financialEntries: Array.isArray(parsed.financialEntries) ? parsed.financialEntries : [],
    preventiveAssessments: Array.isArray(parsed.preventiveAssessments) ? parsed.preventiveAssessments : [],
    auditLog: Array.isArray(parsed.auditLog) ? parsed.auditLog : [],
    idempotency: parsed.idempotency && typeof parsed.idempotency === 'object' ? parsed.idempotency : {}
  };
}
