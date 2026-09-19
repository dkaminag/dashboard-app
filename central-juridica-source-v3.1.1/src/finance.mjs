import { normalizeMoney, normalizeText } from './domain.mjs';

export const FINANCE_DIRECTIONS = ['Receita', 'Despesa'];
export const FINANCE_CATEGORIES = ['Honorários fixos', 'Honorários de êxito', 'Custas', 'Perito', 'Correspondente', 'Reembolso', 'Outros'];
export const REVENUE_STATUSES = ['Previsto', 'Faturado', 'Recebido', 'Cancelado'];
export const EXPENSE_STATUSES = ['Previsto', 'A pagar', 'Pago', 'Cancelado'];

export function validateFinancialEntry(input = {}, { clientIds = new Set(), processes = [] } = {}) {
  const clientId = normalizeText(input.clientId, 100);
  if (!clientIds.has(clientId)) return { ok: false, error: 'Cliente inválido para o lançamento financeiro.' };
  const processId = normalizeText(input.processId, 100);
  if (processId) {
    const process = processes.find(p => p.id === processId);
    if (!process) return { ok: false, error: 'Processo inválido para o lançamento financeiro.' };
    if (process.clientId !== clientId) return { ok: false, error: 'O processo informado não pertence ao cliente selecionado.' };
  }
  const direction = FINANCE_DIRECTIONS.includes(input.direction) ? input.direction : null;
  if (!direction) return { ok: false, error: 'Natureza financeira inválida.' };
  const category = FINANCE_CATEGORIES.includes(input.category) ? input.category : null;
  if (!category) return { ok: false, error: 'Categoria financeira inválida.' };
  const amount = normalizeMoney(input.amount);
  if (amount == null || amount <= 0) return { ok: false, error: 'Valor deve ser maior que zero.' };
  const statuses = direction === 'Receita' ? REVENUE_STATUSES : EXPENSE_STATUSES;
  const status = statuses.includes(input.status) ? input.status : 'Previsto';
  const dueDate = input.dueDate ? normalizeDate(input.dueDate) : null;
  const settledAt = input.settledAt ? normalizeDate(input.settledAt) : null;
  if (input.dueDate && !dueDate) return { ok: false, error: 'Vencimento inválido.' };
  if (input.settledAt && !settledAt) return { ok: false, error: 'Data de liquidação inválida.' };
  if (direction === 'Receita' && status === 'Recebido' && !settledAt) return { ok: false, error: 'Receita recebida exige data de recebimento.' };
  if (direction === 'Despesa' && status === 'Pago' && !settledAt) return { ok: false, error: 'Despesa paga exige data de pagamento.' };
  return { ok: true, value: { clientId, processId: processId || null, direction, category, amount, status, dueDate, settledAt, description: normalizeText(input.description, 500), notes: normalizeText(input.notes, 3000) } };
}

export function financialSummary(entries = [], { now = new Date(), timeZone = 'America/Asuncion' } = {}) {
  const active = entries.filter(e => e.status !== 'Cancelado');
  const revenue = active.filter(e => e.direction === 'Receita');
  const expense = active.filter(e => e.direction === 'Despesa');
  const received = sum(revenue.filter(e => e.status === 'Recebido'));
  const revenuePending = sum(revenue.filter(e => e.status !== 'Recebido'));
  const paid = sum(expense.filter(e => e.status === 'Pago'));
  const expensePending = sum(expense.filter(e => e.status !== 'Pago'));
  const today = dateKey(now, timeZone);
  const attention = active.filter(e => !isSettled(e) && e.dueDate).map(e => {
    const days = dayDiff(today, e.dueDate);
    return { ...e, daysToDue: days, attention: days < 0 ? 'Vencido' : days === 0 ? 'Hoje' : days <= 7 ? 'Próximo' : 'Normal' };
  }).filter(e => e.daysToDue <= 7).sort((a,b) => a.daysToDue - b.daysToDue);
  return {
    revenueReceived: received,
    revenuePending,
    expensesPaid: paid,
    expensesPending: expensePending,
    netCashRealized: round(received - paid),
    projectedNet: round(received + revenuePending - paid - expensePending),
    entries: entries.length,
    attention
  };
}

export function filterFinancialEntries(entries = [], { clientId = null, processId = null } = {}) {
  return entries.filter(e => (!clientId || e.clientId === clientId) && (!processId || e.processId === processId));
}

function isSettled(e) { return (e.direction === 'Receita' && e.status === 'Recebido') || (e.direction === 'Despesa' && e.status === 'Pago'); }
function sum(items) { return round(items.reduce((n,e) => n + Number(e.amount || 0), 0)); }
function round(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function normalizeDate(value) { const s = String(value || '').trim(); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null; const d = new Date(`${s}T00:00:00Z`); return Number.isNaN(d.getTime()) ? null : s; }
function dateKey(date, timeZone) { const parts = new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date); const map=Object.fromEntries(parts.map(p=>[p.type,p.value])); return `${map.year}-${map.month}-${map.day}`; }
function dayDiff(a,b){return Math.round((Date.parse(`${b}T00:00:00Z`)-Date.parse(`${a}T00:00:00Z`))/86400000);}
