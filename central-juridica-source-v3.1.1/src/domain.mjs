import crypto from 'node:crypto';

export const AREAS = ['Trabalhista', 'Cível', 'Consumidor', 'Empresarial', 'Preventivo'];
export const RISKS = ['Baixo', 'Médio-baixo', 'Médio', 'Médio-alto', 'Alto'];
export const PRIORITIES = ['Baixa', 'Média', 'Alta', 'Crítica'];

export function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function normalizeText(value, max = 5000) {
  if (value == null) return '';
  return String(value).trim().slice(0, max);
}

export function normalizeMoney(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number * 100) / 100;
}

export function normalizeDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : s;
}

export function validateClient(input = {}) {
  const name = normalizeText(input.name, 160);
  if (name.length < 2) return { ok: false, error: 'Nome do cliente é obrigatório.' };
  return {
    ok: true,
    value: {
      name,
      type: normalizeText(input.type, 80) || 'Empresa',
      contact: normalizeText(input.contact, 160),
      email: normalizeText(input.email, 200),
      phone: normalizeText(input.phone, 80),
      status: normalizeText(input.status, 40) || 'Ativo'
    }
  };
}

export function validateProcess(input = {}, clientIds = new Set()) {
  const title = normalizeText(input.title, 200);
  const clientId = normalizeText(input.clientId, 100);
  if (title.length < 3) return { ok: false, error: 'Título/identificação do processo é obrigatório.' };
  if (!clientIds.has(clientId)) return { ok: false, error: 'Cliente inválido.' };

  const area = AREAS.includes(input.area) ? input.area : 'Cível';
  const risk = RISKS.includes(input.risk) ? input.risk : 'Médio';
  const nextDeadline = input.nextDeadline ? normalizeDate(input.nextDeadline) : null;
  if (input.nextDeadline && !nextDeadline) return { ok: false, error: 'Prazo deve estar no formato AAAA-MM-DD.' };

  return {
    ok: true,
    value: {
      number: normalizeText(input.number, 100),
      title,
      clientId,
      area,
      stage: normalizeText(input.stage, 100) || 'Análise inicial',
      status: normalizeText(input.status, 40) || 'Ativo',
      risk,
      requestedValue: normalizeMoney(input.requestedValue),
      agreementInitial: normalizeMoney(input.agreementInitial),
      agreementCeiling: normalizeMoney(input.agreementCeiling),
      nextDeadline,
      nextAction: normalizeText(input.nextAction, 500),
      owner: normalizeText(input.owner, 120),
      facts: normalizeText(input.facts, 8000),
      opposingThesis: normalizeText(input.opposingThesis, 8000),
      ourThesis: normalizeText(input.ourThesis, 8000),
      evidence: normalizeText(input.evidence, 8000),
      strategy: normalizeText(input.strategy, 8000)
    }
  };
}

export function validateTask(input = {}, processIds = new Set()) {
  const title = normalizeText(input.title, 220);
  if (title.length < 3) return { ok: false, error: 'Descrição da tarefa é obrigatória.' };
  const processId = normalizeText(input.processId, 100);
  if (processId && !processIds.has(processId)) return { ok: false, error: 'Processo inválido.' };
  const dueDate = input.dueDate ? normalizeDate(input.dueDate) : null;
  if (input.dueDate && !dueDate) return { ok: false, error: 'Data da tarefa inválida.' };
  return {
    ok: true,
    value: {
      title,
      processId: processId || null,
      priority: PRIORITIES.includes(input.priority) ? input.priority : 'Média',
      dueDate,
      status: normalizeText(input.status, 40) || 'Pendente',
      owner: normalizeText(input.owner, 120)
    }
  };
}

function daysUntil(dateString, now = new Date(), timeZone = 'America/Sao_Paulo') {
  if (!dateString) return null;
  const today = dateKey(now, timeZone);
  return Math.round((Date.parse(`${dateString}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
}

function dateKey(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

export function auditProcess(process, now = new Date(), timeZone = 'America/Sao_Paulo') {
  const findings = [];
  const nextActions = [];
  const missing = [];

  const required = [
    ['facts', 'Fatos relevantes'],
    ['ourThesis', 'Nossa tese'],
    ['evidence', 'Provas/evidências'],
    ['strategy', 'Estratégia'],
    ['nextAction', 'Próxima providência']
  ];
  for (const [field, label] of required) {
    if (!normalizeText(process[field], 100).trim()) missing.push(label);
  }

  const d = daysUntil(process.nextDeadline, now, timeZone);
  if (d != null && d < 0) {
    findings.push({ severity: 'Crítico', kind: 'Fato confirmado', message: `Prazo cadastrado está vencido há ${Math.abs(d)} dia(s).` });
    nextActions.push('Revisar imediatamente a situação processual e confirmar se houve perda de prazo ou cumprimento por outro meio.');
  } else if (d != null && d <= 2) {
    findings.push({ severity: 'Alto', kind: 'Fato confirmado', message: `Prazo cadastrado vence em ${d} dia(s).` });
    nextActions.push('Priorizar a providência vinculada ao prazo e registrar evidência de conclusão.');
  } else if (d != null && d <= 7) {
    findings.push({ severity: 'Médio', kind: 'Fato confirmado', message: `Há prazo dentro dos próximos 7 dias (${process.nextDeadline}).` });
  }

  if ((process.risk === 'Alto' || process.risk === 'Médio-alto') && !process.strategy) {
    findings.push({ severity: 'Alto', kind: 'Risco potencial', message: 'Processo de risco elevado sem estratégia registrada.' });
  }

  if (process.requestedValue != null && process.agreementCeiling != null && process.agreementCeiling > process.requestedValue) {
    findings.push({ severity: 'Médio', kind: 'Risco potencial', message: 'Teto de acordo está acima do valor pedido; revisar parametrização.' });
  }

  if (missing.length) {
    findings.push({ severity: missing.length >= 3 ? 'Alto' : 'Médio', kind: 'Fato confirmado', message: `Memória do processo incompleta: ${missing.join(', ')}.` });
    nextActions.push('Completar a memória estruturada antes de gerar peça ou recomendação automatizada.');
  }

  if (!findings.length) {
    findings.push({ severity: 'Baixo', kind: 'Recomendação', message: 'Não foram detectados bloqueios básicos pela auditoria local. Ainda é necessária revisão jurídica humana.' });
  }

  const score = Math.max(0, 100 - findings.reduce((sum, f) => sum + ({ Crítico: 35, Alto: 20, Médio: 10, Baixo: 3 }[f.severity] || 0), 0));
  return {
    generatedAt: new Date().toISOString(),
    score,
    decision: findings.some(f => f.severity === 'Crítico') ? 'NÃO PRONTO' : findings.some(f => f.severity === 'Alto') ? 'PRONTO COM RESSALVAS' : 'PRONTO PARA REVISÃO HUMANA',
    findings,
    missing,
    nextActions,
    limitations: [
      'Auditoria local baseada em regras; não substitui análise jurídica profissional.',
      'Não consulta movimentações processuais externas nem tribunais.',
      'Não envia dados a provedores de IA externos nesta versão.'
    ]
  };
}

export function dashboardStats(db, now = new Date(), timeZone = 'America/Sao_Paulo') {
  const active = db.processes.filter(p => p.status !== 'Encerrado');
  const next7 = active.filter(p => {
    const d = daysUntil(p.nextDeadline, now, timeZone);
    return d != null && d >= 0 && d <= 7;
  });
  const overdue = active.filter(p => {
    const d = daysUntil(p.nextDeadline, now, timeZone);
    return d != null && d < 0;
  });
  const highRisk = active.filter(p => ['Alto', 'Médio-alto'].includes(p.risk));
  const pendingTasks = db.tasks.filter(t => t.status !== 'Concluída');
  return {
    activeProcesses: active.length,
    deadlinesNext7Days: next7.length,
    overdueDeadlines: overdue.length,
    highRiskProcesses: highRisk.length,
    pendingTasks: pendingTasks.length,
    activeClients: db.clients.filter(c => c.status !== 'Inativo').length
  };
}
