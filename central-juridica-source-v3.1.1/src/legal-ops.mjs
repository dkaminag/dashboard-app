import { normalizeDate, normalizeMoney, normalizeText } from './domain.mjs';

export const AGREEMENT_DIRECTIONS = ['Nossa proposta', 'Proposta contrária', 'Acordo fechado'];
export const AGREEMENT_STATUSES = ['Em negociação', 'Aceita', 'Recusada', 'Expirada'];
export const EXECUTION_MEASURES = ['SISBAJUD', 'RENAJUD', 'INFOJUD', 'Penhora', 'Protesto', 'Intimação', 'Pesquisa patrimonial', 'Outra'];
export const EXECUTION_STATUSES = ['Planejada', 'Solicitada', 'Em andamento', 'Cumprida', 'Negativa', 'Cancelada'];

export function validateAgreement(input = {}, processIds = new Set()) {
  const processId = normalizeText(input.processId, 100);
  if (!processIds.has(processId)) return { ok: false, error: 'Processo inválido para o acordo.' };
  const amount = normalizeMoney(input.amount);
  if (amount == null || amount <= 0) return { ok: false, error: 'Valor da proposta deve ser maior que zero.' };
  const direction = AGREEMENT_DIRECTIONS.includes(input.direction) ? input.direction : 'Nossa proposta';
  const status = AGREEMENT_STATUSES.includes(input.status) ? input.status : 'Em negociação';
  const occurredAt = input.occurredAt ? normalizeDate(input.occurredAt) : null;
  if (input.occurredAt && !occurredAt) return { ok: false, error: 'Data da proposta inválida.' };
  return { ok: true, value: { processId, amount, direction, status, occurredAt, notes: normalizeText(input.notes, 3000) } };
}

export function validateExecutionAction(input = {}, processIds = new Set()) {
  const processId = normalizeText(input.processId, 100);
  if (!processIds.has(processId)) return { ok: false, error: 'Processo inválido para a medida executiva.' };
  const measure = EXECUTION_MEASURES.includes(input.measure) ? input.measure : null;
  if (!measure) return { ok: false, error: 'Medida executiva inválida.' };
  const status = EXECUTION_STATUSES.includes(input.status) ? input.status : 'Planejada';
  const requestedAt = input.requestedAt ? normalizeDate(input.requestedAt) : null;
  const reviewDate = input.reviewDate ? normalizeDate(input.reviewDate) : null;
  if (input.requestedAt && !requestedAt) return { ok: false, error: 'Data da medida inválida.' };
  if (input.reviewDate && !reviewDate) return { ok: false, error: 'Data de revisão inválida.' };
  return { ok: true, value: { processId, measure, status, requestedAt, reviewDate, result: normalizeText(input.result, 4000), notes: normalizeText(input.notes, 3000) } };
}

export function executionAttention(actions = [], now = new Date(), timeZone = 'America/Sao_Paulo') {
  const today = dateKey(now, timeZone);
  return actions.filter(a => !['Cumprida', 'Cancelada'].includes(a.status) && a.reviewDate).map(a => {
    const days = dayDiff(today, a.reviewDate);
    return { ...a, daysToReview: days, attention: days < 0 ? 'Vencida' : days === 0 ? 'Hoje' : days <= 7 ? 'Próxima' : 'Normal' };
  }).filter(a => a.daysToReview <= 7).sort((a,b) => a.daysToReview - b.daysToReview);
}

function dateKey(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const map=Object.fromEntries(parts.map(p=>[p.type,p.value])); return `${map.year}-${map.month}-${map.day}`;
}
function dayDiff(a,b){return Math.round((Date.parse(`${b}T00:00:00Z`)-Date.parse(`${a}T00:00:00Z`))/86400000);}
