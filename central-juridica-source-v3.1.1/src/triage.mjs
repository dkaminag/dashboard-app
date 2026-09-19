const PRIORITY_WEIGHT = { Crítica: 25, Alta: 15, Média: 7, Baixa: 0 };
const RISK_WEIGHT = { Alto: 20, 'Médio-alto': 12, Médio: 5, 'Médio-baixo': 2, Baixo: 0 };

export function buildDailyBrief({ processes = [], tasks = [], calendarEvents = [], emailMetadata = [], now = new Date(), timeZone = 'America/Sao_Paulo' } = {}) {
  const today = dateKey(now, timeZone);
  const processMap = new Map(processes.map(p => [p.id, p]));
  const priorities = [];

  for (const task of tasks.filter(t => t.status !== 'Concluída')) {
    const days = task.dueDate ? dayDiff(today, task.dueDate) : null;
    let score = 30 + (PRIORITY_WEIGHT[task.priority] || 0);
    let reason = 'Tarefa pendente';
    if (days != null && days < 0) { score += 80; reason = `Tarefa vencida há ${Math.abs(days)} dia(s)`; }
    else if (days === 0) { score += 70; reason = 'Tarefa vence hoje'; }
    else if (days != null && days <= 2) { score += 55; reason = `Tarefa vence em ${days} dia(s)`; }
    else if (days != null && days <= 7) { score += 30; reason = `Tarefa vence em ${days} dia(s)`; }
    const process = task.processId ? processMap.get(task.processId) : null;
    if (process) score += Math.floor((RISK_WEIGHT[process.risk] || 0) / 2);
    priorities.push({ kind: 'task', id: task.id, processId: task.processId || null, title: task.title, dueDate: task.dueDate || null, score, severity: severity(score), reason });
  }

  for (const process of processes.filter(p => p.status !== 'Encerrado')) {
    const days = process.nextDeadline ? dayDiff(today, process.nextDeadline) : null;
    let score = RISK_WEIGHT[process.risk] || 0;
    let reason = process.risk === 'Alto' || process.risk === 'Médio-alto' ? `Risco ${process.risk}` : '';
    if (days != null && days < 0) { score += 120; reason = `Prazo processual vencido há ${Math.abs(days)} dia(s)`; }
    else if (days === 0) { score += 90; reason = 'Prazo processual vence hoje'; }
    else if (days != null && days <= 2) { score += 70; reason = `Prazo processual vence em ${days} dia(s)`; }
    else if (days != null && days <= 7) { score += 45; reason = `Prazo processual vence em ${days} dia(s)`; }
    if (process.nextAction && score) score += 3;
    if (score >= 20) priorities.push({ kind: 'process', id: process.id, processId: process.id, title: process.title, dueDate: process.nextDeadline || null, score, severity: severity(score), reason: reason || 'Revisão recomendada' });
  }

  const todayEvents = calendarEvents.filter(event => dateFromCalendar(event.start, timeZone) === today).map(event => ({
    kind: 'calendar', id: event.id, processId: null, title: event.summary || '(sem título)', dueDate: today, score: 75, severity: 'Alta', reason: 'Evento de agenda hoje', start: event.start, end: event.end
  }));
  priorities.push(...todayEvents);

  const emailCorrelations = [];
  for (const email of emailMetadata) {
    const matches = matchEmailToProcesses(email, processes);
    for (const match of matches.slice(0, 3)) emailCorrelations.push({ emailId: email.id, subject: email.subject || '(sem assunto)', from: email.from || '', processId: match.processId, processTitle: match.processTitle, score: match.score, reason: match.reason });
  }

  priorities.sort((a,b) => b.score - a.score || String(a.title).localeCompare(String(b.title)));
  emailCorrelations.sort((a,b) => b.score - a.score);
  const high = priorities.filter(x => x.severity === 'Crítica' || x.severity === 'Alta').length;
  return {
    generatedAt: new Date().toISOString(),
    timeZone,
    date: today,
    summary: {
      totalPriorities: priorities.length,
      urgentOrHigh: high,
      overdue: priorities.filter(x => /vencid[oa]/i.test(x.reason)).length,
      todayEvents: todayEvents.length,
      emailCorrelations: emailCorrelations.length
    },
    priorities: priorities.slice(0, 20),
    emailCorrelations: emailCorrelations.slice(0, 20),
    limitations: [
      'Priorização determinística baseada apenas nos dados cadastrados e metadados fornecidos.',
      'Correlação de e-mails é sugestão, nunca vínculo automático.',
      'Não consulta movimentações processuais de tribunais.'
    ]
  };
}

export function matchEmailToProcesses(email, processes = []) {
  const haystack = normalize(`${email.subject || ''} ${email.from || ''}`);
  const hayDigits = digits(haystack);
  const matches = [];
  for (const process of processes) {
    let score = 0;
    const reasons = [];
    const numberDigits = digits(process.number || '');
    if (numberDigits.length >= 8 && hayDigits.includes(numberDigits)) { score += 100; reasons.push('número do processo'); }
    const tokens = meaningfulTokens(`${process.title || ''} ${process.clientName || ''}`);
    const hits = tokens.filter(t => haystack.includes(t));
    if (hits.length >= 2) { score += Math.min(60, hits.length * 15); reasons.push(`${hits.length} termos do processo/cliente`); }
    else if (hits.length === 1 && hits[0].length >= 7) { score += 15; reasons.push('termo distintivo'); }
    if (score >= 30) matches.push({ processId: process.id, processTitle: process.title, score, reason: reasons.join(' + ') });
  }
  return matches.sort((a,b) => b.score - a.score);
}

function meaningfulTokens(value) {
  return [...new Set(normalize(value).split(/\s+/).filter(t => t.length >= 5 && !STOP.has(t)))];
}
function normalize(value) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }
function digits(value) { return String(value || '').replace(/\D/g,''); }
function severity(score) { return score >= 100 ? 'Crítica' : score >= 70 ? 'Alta' : score >= 45 ? 'Média' : 'Baixa'; }
function dayDiff(a,b) { return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`))/86400000); }
function dateKey(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const m=Object.fromEntries(parts.map(p=>[p.type,p.value])); return `${m.year}-${m.month}-${m.day}`;
}
function dateFromCalendar(value, timeZone) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value); return Number.isNaN(date.getTime()) ? null : dateKey(date,timeZone);
}
const STOP = new Set(['processo','contra','sobre','cliente','empresa','acao','autos','civil','civel','trabalhista','reclamacao','reclamante','reclamada','peticao']);
