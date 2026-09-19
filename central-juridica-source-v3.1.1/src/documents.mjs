import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeText } from './domain.mjs';

export const DOCUMENT_MIME = new Map([
  ['.pdf', 'application/pdf'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.txt', 'text/plain'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png']
]);

export function validateDocumentInput(input = {}, processIds = new Set(), maxBytes = 10 * 1024 * 1024) {
  const name = normalizeText(input.name, 220);
  const processId = normalizeText(input.processId, 100);
  const mimeType = normalizeText(input.mimeType, 160).toLowerCase();
  const contentBase64 = String(input.contentBase64 || '');
  if (!name || name === '.' || name === '..') return { ok: false, error: 'Nome do documento é obrigatório.' };
  const baseName = path.basename(name).replace(/[\u0000-\u001f]/g, '');
  if (baseName !== name || baseName.length < 1) return { ok: false, error: 'Nome de arquivo inválido.' };
  if (processId && !processIds.has(processId)) return { ok: false, error: 'Processo inválido.' };
  const ext = path.extname(baseName).toLowerCase();
  const expectedMime = DOCUMENT_MIME.get(ext);
  if (!expectedMime) return { ok: false, error: 'Tipo de arquivo não permitido.' };
  if (mimeType !== expectedMime) return { ok: false, error: 'Extensão e MIME do documento não correspondem.' };
  let bytes;
  try { bytes = Buffer.from(contentBase64, 'base64'); } catch { return { ok: false, error: 'Conteúdo do documento inválido.' }; }
  if (!bytes.length) return { ok: false, error: 'Documento vazio.' };
  if (bytes.length > maxBytes) return { ok: false, error: `Documento excede o limite de ${Math.round(maxBytes / 1024 / 1024)} MB.` };
  const canonical = bytes.toString('base64').replace(/=+$/,'');
  if (canonical !== contentBase64.replace(/\s+/g,'').replace(/=+$/,'')) return { ok: false, error: 'Base64 do documento é inválido.' };
  return {
    ok: true,
    value: {
      name: baseName,
      processId: processId || null,
      mimeType: expectedMime,
      bytes,
      size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex')
    }
  };
}

export function safeStorageName(documentId, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  return `${documentId}${ext}`;
}
