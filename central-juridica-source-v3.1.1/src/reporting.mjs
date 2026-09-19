import { auditProcess } from './domain.mjs';
import { executionAttention } from './legal-ops.mjs';
import { filterFinancialEntries, financialSummary } from './finance.mjs';

export function processStatusReport(db, processId, { now = new Date(), timeZone = 'America/Sao_Paulo' } = {}) {
  const process = db.processes.find(p => p.id === processId);
  if (!process) throw Object.assign(new Error('Processo não encontrado.'), { status: 404 });
  const client = db.clients.find(c => c.id === process.clientId) || null;
  const tasks = db.tasks.filter(t => t.processId === processId);
  const agreements = db.agreements.filter(a => a.processId === processId).slice().sort((a,b) => String(b.occurredAt || b.createdAt).localeCompare(String(a.occurredAt || a.createdAt)));
  const executions = db.executionActions.filter(a => a.processId === processId);
  const documents = db.documents.filter(d => d.processId === processId);
  const localAudit = auditProcess(process, now, timeZone);
  const finance = financialSummary(filterFinancialEntries(db.financialEntries, { processId }), { now, timeZone });
  return {
    generatedAt: new Date().toISOString(),
    process: {
      id: process.id, number: process.number, title: process.title, area: process.area, stage: process.stage,
      status: process.status, risk: process.risk, requestedValue: process.requestedValue,
      agreementInitial: process.agreementInitial, agreementCeiling: process.agreementCeiling,
      nextDeadline: process.nextDeadline, nextAction: process.nextAction, owner: process.owner
    },
    client: client ? { id: client.id, name: client.name, contact: client.contact, email: client.email, phone: client.phone } : null,
    memory: { facts: process.facts, opposingThesis: process.opposingThesis, ourThesis: process.ourThesis, evidence: process.evidence, strategy: process.strategy },
    tasks: { total: tasks.length, pending: tasks.filter(t => t.status !== 'Concluída').length, items: tasks },
    agreements: { total: agreements.length, latest: agreements[0] || null, items: agreements },
    executions: { total: executions.length, attention: executionAttention(executions, now, timeZone), items: executions },
    documents: { total: documents.length, items: documents.map(d => ({ id: d.id, name: d.name, mimeType: d.mimeType, size: d.size, sha256: d.sha256, createdAt: d.createdAt })) },
    finance,
    localAudit,
    limitations: ['Relatório baseado somente nos dados cadastrados na Central Jurídica.', 'Não confirma movimentações externas de tribunal.']
  };
}

export function clientPortfolioReport(db, clientId, { now = new Date(), timeZone = 'America/Sao_Paulo' } = {}) {
  const client = db.clients.find(c => c.id === clientId);
  if (!client) throw Object.assign(new Error('Cliente não encontrado.'), { status: 404 });
  const processes = db.processes.filter(p => p.clientId === clientId).map(p => {
    const tasks = db.tasks.filter(t => t.processId === p.id && t.status !== 'Concluída');
    const agreements = db.agreements.filter(a => a.processId === p.id).slice().sort((a,b) => String(b.occurredAt || b.createdAt).localeCompare(String(a.occurredAt || a.createdAt)));
    const executions = db.executionActions.filter(a => a.processId === p.id);
    const audit = auditProcess(p, now, timeZone);
    return {
      id: p.id, number: p.number, title: p.title, area: p.area, stage: p.stage, status: p.status, risk: p.risk,
      requestedValue: p.requestedValue, nextDeadline: p.nextDeadline, nextAction: p.nextAction, owner: p.owner,
      pendingTasks: tasks.length, latestAgreementAmount: agreements[0]?.amount ?? null, latestAgreementStatus: agreements[0]?.status ?? null,
      executionAttention: executionAttention(executions, now, timeZone).length,
      auditDecision: audit.decision, auditScore: audit.score
    };
  });
  const requestedKnown = processes.filter(p => p.requestedValue != null);
  const finance = financialSummary(filterFinancialEntries(db.financialEntries, { clientId }), { now, timeZone });
  return {
    generatedAt: new Date().toISOString(),
    client: { id: client.id, name: client.name, type: client.type, status: client.status, contact: client.contact, email: client.email, phone: client.phone },
    summary: {
      processes: processes.length,
      activeProcesses: processes.filter(p => p.status !== 'Encerrado').length,
      highRisk: processes.filter(p => ['Alto','Médio-alto'].includes(p.risk)).length,
      pendingTasks: processes.reduce((n,p) => n + p.pendingTasks, 0),
      requestedValueKnownTotal: requestedKnown.reduce((n,p) => n + p.requestedValue, 0),
      requestedValueKnownCount: requestedKnown.length
    },
    finance,
    processes,
    limitations: ['Totais financeiros somam apenas processos com valor cadastrado.', 'Relatório não consulta fontes externas.']
  };
}

export function clientPortfolioCsv(report) {
  const headers = ['Processo','Título','Área','Fase','Status','Risco','Valor pedido','Próximo prazo','Próxima ação','Responsável','Tarefas pendentes','Último acordo','Status acordo','Execuções a revisar','Auditoria','Score'];
  const rows = report.processes.map(p => [p.number,p.title,p.area,p.stage,p.status,p.risk,p.requestedValue,p.nextDeadline,p.nextAction,p.owner,p.pendingTasks,p.latestAgreementAmount,p.latestAgreementStatus,p.executionAttention,p.auditDecision,p.auditScore]);
  return '\uFEFF' + [headers, ...rows].map(row => row.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

export function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"','""')}"`;
}
