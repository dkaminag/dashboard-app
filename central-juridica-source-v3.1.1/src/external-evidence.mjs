import crypto from 'node:crypto';

export const EVIDENCE_PROVIDERS = ['Gmail', 'Google Calendar', 'Google Drive'];
export const EVIDENCE_KINDS = ['E-mail', 'Evento', 'Arquivo'];
export const EVIDENCE_STATUSES = ['Pendente', 'Vinculado', 'Descartado'];

const FORBIDDEN_CONTENT_FIELDS = new Set([
  'body', 'content', 'raw', 'snippet', 'html', 'text', 'attachment', 'attachments',
  'attachmentData', 'fileContent', 'messageBody', 'descriptionFull'
]);

export function metadataFingerprint(input = {}) {
  const stable = [input.provider, input.externalId, input.kind, input.title, input.occurredAt].map(v => String(v || '').trim()).join('\u001f');
  return crypto.createHash('sha256').update(stable).digest('hex');
}

export function validateEvidenceCandidate(input = {}, { processIds = new Set() } = {}) {
  for (const key of Object.keys(input || {})) {
    if (FORBIDDEN_CONTENT_FIELDS.has(key) && input[key] !== undefined && input[key] !== null && String(input[key]).trim() !== '') {
      return { ok: false, error: `Campo de conteúdo não permitido na evidência: ${key}. Armazene apenas metadados.` };
    }
  }
  const provider = String(input.provider || '').trim();
  const externalId = String(input.externalId || '').trim();
  const kind = String(input.kind || '').trim();
  const title = String(input.title || '').trim();
  const occurredAt = String(input.occurredAt || '').trim();
  const proposedProcessId = String(input.proposedProcessId || '').trim() || null;
  const sourceReference = String(input.sourceReference || '').trim().slice(0, 500) || null;
  const reason = String(input.reason || '').trim().slice(0, 1000) || null;
  if (!EVIDENCE_PROVIDERS.includes(provider)) return { ok: false, error: 'Provedor de evidência inválido.' };
  if (!externalId || externalId.length > 300) return { ok: false, error: 'externalId é obrigatório e deve ter no máximo 300 caracteres.' };
  if (!EVIDENCE_KINDS.includes(kind)) return { ok: false, error: 'Tipo de evidência inválido.' };
  if (!title || title.length > 500) return { ok: false, error: 'Título é obrigatório e deve ter no máximo 500 caracteres.' };
  if (!occurredAt || Number.isNaN(Date.parse(occurredAt))) return { ok: false, error: 'Data/hora da evidência é inválida.' };
  if (proposedProcessId && !processIds.has(proposedProcessId)) return { ok: false, error: 'Processo sugerido não encontrado.' };
  const value = { provider, externalId, kind, title, occurredAt: new Date(occurredAt).toISOString(), proposedProcessId, sourceReference, reason };
  value.metadataHash = metadataFingerprint(value);
  return { ok: true, value };
}

export function validateEvidenceReview(input = {}, { processIds = new Set() } = {}) {
  const decision = String(input.decision || '').trim();
  const processId = String(input.processId || '').trim() || null;
  const reviewNote = String(input.reviewNote || '').trim().slice(0, 1500) || null;
  if (!['Vincular', 'Descartar'].includes(decision)) return { ok: false, error: 'Decisão deve ser Vincular ou Descartar.' };
  if (decision === 'Vincular' && (!processId || !processIds.has(processId))) return { ok: false, error: 'Processo válido é obrigatório para vincular a evidência.' };
  return { ok: true, value: { decision, processId: decision === 'Vincular' ? processId : null, reviewNote } };
}

export function evidenceQueueSummary(items = []) {
  const summary = { total: items.length, pending: 0, linked: 0, dismissed: 0, withProposal: 0 };
  for (const item of items) {
    if (item.status === 'Pendente') summary.pending += 1;
    if (item.status === 'Vinculado') summary.linked += 1;
    if (item.status === 'Descartado') summary.dismissed += 1;
    if (item.status === 'Pendente' && item.proposedProcessId) summary.withProposal += 1;
  }
  return summary;
}

export function publicEvidence(item = {}) {
  const allowed = [
    'id','provider','externalId','kind','title','occurredAt','proposedProcessId','processId','status',
    'sourceReference','reason','reviewNote','metadataHash','ingestedAt','reviewedAt','reviewedBy','createdBy'
  ];
  return Object.fromEntries(allowed.filter(key => item[key] !== undefined).map(key => [key, item[key]]));
}
