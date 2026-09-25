import { parentPort, workerData } from "node:worker_threads";

const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const STANDARD_FONT_DATA_URL = new URL("./node_modules/pdfjs-dist/standard_fonts/", import.meta.url).href;

function extractionError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function enforceSize(text, maxChars) {
  if (text.length > maxChars) throw extractionError("AI_PROVIDER_TEXT_FILE_TOO_LARGE");
}

async function extractPdf(bytes, maxChars, maxPdfPages) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  });

  let pdf;
  try {
    pdf = await loadingTask.promise;
  } catch (error) {
    if (error?.name === "PasswordException") {
      throw extractionError("AI_PROVIDER_FILE_PASSWORD_REQUIRED");
    }
    throw error;
  }

  try {
    if (!Number.isInteger(pdf.numPages) || pdf.numPages < 1) {
      throw extractionError("AI_PROVIDER_FILE_NO_TEXT");
    }
    if (pdf.numPages > maxPdfPages) {
      throw extractionError("AI_PROVIDER_DOCUMENT_TOO_LARGE");
    }

    let out = "";
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const parts = [];
      for (const item of textContent.items || []) {
        if (typeof item?.str !== "string") continue;
        parts.push(item.str);
        parts.push(item.hasEOL ? "\n" : " ");
      }
      const pageText = cleanText(parts.join(""));
      if (pageText) {
        out += `\n[PDF página ${pageNumber}]\n${pageText}\n`;
        enforceSize(out, maxChars);
      }
      page.cleanup?.();
    }

    const normalized = cleanText(out);
    if (!normalized) throw extractionError("AI_PROVIDER_FILE_NO_TEXT");
    return { text: normalized, kind: "pdf", pages: pdf.numPages };
  } finally {
    await pdf.destroy().catch(() => {});
  }
}

async function extractDocx(bytes, maxChars) {
  const module = await import("mammoth");
  const mammoth = module.default || module;
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  const text = cleanText(result?.value);
  if (!text) throw extractionError("AI_PROVIDER_FILE_NO_TEXT");
  enforceSize(text, maxChars);
  return { text, kind: "docx", pages: null };
}

async function main() {
  const mime = String(workerData?.mime || "").toLowerCase();
  const bytes = workerData?.bytes;
  const maxChars = Number(workerData?.maxChars || 0);
  const maxPdfPages = Number(workerData?.maxPdfPages || 0);
  if (!(bytes instanceof Uint8Array) || !Number.isInteger(maxChars) || maxChars <= 0) {
    throw extractionError("AI_PROVIDER_FILE_EXTRACTION_FAILED");
  }

  if (mime === PDF_MIME) return extractPdf(bytes, maxChars, maxPdfPages);
  if (mime === DOCX_MIME) return extractDocx(bytes, maxChars);
  throw extractionError("AI_PROVIDER_FILE_UNSUPPORTED");
}

try {
  const result = await main();
  parentPort.postMessage({ ok: true, ...result });
} catch (error) {
  const known = new Set([
    "AI_PROVIDER_FILE_NO_TEXT",
    "AI_PROVIDER_TEXT_FILE_TOO_LARGE",
    "AI_PROVIDER_FILE_PASSWORD_REQUIRED",
    "AI_PROVIDER_DOCUMENT_TOO_LARGE",
    "AI_PROVIDER_FILE_UNSUPPORTED",
  ]);
  const code = known.has(error?.code) ? error.code : "AI_PROVIDER_FILE_EXTRACTION_FAILED";
  parentPort.postMessage({ ok: false, code });
}
