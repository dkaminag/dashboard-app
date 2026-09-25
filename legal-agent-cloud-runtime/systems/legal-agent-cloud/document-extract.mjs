import { Worker } from "node:worker_threads";

export const TEXT_ATTACHMENT_MIME = new Set(["text/plain", "text/rtf", "application/rtf"]);
export const PDF_MIME = "application/pdf";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const LOCAL_DOCUMENT_MIME = new Set([PDF_MIME, DOCX_MIME]);
export const LOCALLY_READABLE_MIME = new Set([...TEXT_ATTACHMENT_MIME, ...LOCAL_DOCUMENT_MIME]);

const WORKER_URL = new URL("./document-extract-worker.mjs", import.meta.url);
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_CHARS = 180_000;
const DEFAULT_MAX_PDF_PAGES = 400;

export class DocumentExtractionError extends Error {
  constructor(code) {
    super(code);
    this.name = "DocumentExtractionError";
    this.code = code;
    this.statusCode = 400;
  }
}

export function isLocallyReadableMime(mime) {
  return LOCALLY_READABLE_MIME.has(String(mime || "").toLowerCase());
}

function cleanExtractedText(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function assertUsableText(text, maxChars) {
  if (!text || text.length < 2) throw new DocumentExtractionError("AI_PROVIDER_FILE_NO_TEXT");
  if (text.length > maxChars) throw new DocumentExtractionError("AI_PROVIDER_TEXT_FILE_TOO_LARGE");
}

function runWorker(bytes, mime, { timeoutMs, maxChars, maxPdfPages }) {
  return new Promise((resolve, reject) => {
    const transferable = Uint8Array.from(bytes);
    let settled = false;
    const worker = new Worker(WORKER_URL, {
      workerData: {
        mime,
        bytes: transferable,
        maxChars,
        maxPdfPages,
      },
      transferList: [transferable.buffer],
      resourceLimits: {
        maxOldGenerationSizeMb: 192,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4,
      },
    });

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };

    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      finish(reject, new DocumentExtractionError("AI_PROVIDER_FILE_EXTRACTION_TIMEOUT"));
    }, timeoutMs);
    timer.unref?.();

    worker.once("message", (message) => {
      if (!message?.ok) {
        finish(reject, new DocumentExtractionError(message?.code || "AI_PROVIDER_FILE_EXTRACTION_FAILED"));
        return;
      }
      finish(resolve, message);
    });
    worker.once("error", () => {
      finish(reject, new DocumentExtractionError("AI_PROVIDER_FILE_EXTRACTION_FAILED"));
    });
    worker.once("exit", (code) => {
      if (!settled && code !== 0) {
        finish(reject, new DocumentExtractionError("AI_PROVIDER_FILE_EXTRACTION_FAILED"));
      }
    });
  });
}

export async function extractAttachmentText(file, options = {}) {
  const mime = String(file?.mime || "").toLowerCase();
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0
    ? options.maxChars
    : DEFAULT_MAX_CHARS;

  if (TEXT_ATTACHMENT_MIME.has(mime)) {
    const text = cleanExtractedText(Buffer.from(String(file?.data || ""), "base64").toString("utf8"));
    assertUsableText(text, maxChars);
    return { text, kind: "text", pages: null };
  }

  if (!LOCAL_DOCUMENT_MIME.has(mime)) {
    throw new DocumentExtractionError("AI_PROVIDER_FILE_UNSUPPORTED");
  }

  const raw = Buffer.from(String(file?.data || ""), "base64");
  const result = await runWorker(raw, mime, {
    timeoutMs: Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS,
    maxChars,
    maxPdfPages: Number.isInteger(options.maxPdfPages) && options.maxPdfPages > 0
      ? options.maxPdfPages
      : DEFAULT_MAX_PDF_PAGES,
  });

  const text = cleanExtractedText(result.text);
  assertUsableText(text, maxChars);
  return {
    text,
    kind: result.kind || "document",
    pages: Number.isInteger(result.pages) ? result.pages : null,
  };
}
