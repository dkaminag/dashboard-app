export const DEFAULT_GROQ_INPUT_BUDGET_BYTES = 240_000;
export const DEFAULT_GROQ_WEB_INPUT_BUDGET_BYTES = 160_000;

const MIN_GROQ_INPUT_BUDGET_BYTES = 64 * 1024;
const MAX_GROQ_INPUT_BUDGET_BYTES = 320_000;
const DEFAULT_MESSAGE_OVERHEAD_BYTES = 64;
const DEFAULT_ENVELOPE_OVERHEAD_BYTES = 1024;

export class ContextBudgetError extends Error {
  constructor(message, details = {}) {
    super("AI_CONTEXT_TOO_LARGE");
    this.reason = message;
    this.name = "ContextBudgetError";
    this.code = "AI_CONTEXT_TOO_LARGE";
    this.inputBytes = details.inputBytes ?? null;
    this.budgetBytes = details.budgetBytes ?? null;
    this.historyIncluded = details.historyIncluded ?? 0;
    this.historyOmitted = details.historyOmitted ?? 0;
  }
}

export function boundedGroqInputBudget(rawValue, fallback) {
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed)) return fallback;
  if (parsed < MIN_GROQ_INPUT_BUDGET_BYTES || parsed > MAX_GROQ_INPUT_BUDGET_BYTES) {
    return fallback;
  }
  return parsed;
}

export function utf8Bytes(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

export function selectRecentHistoryWithinBudget({
  history,
  instructions,
  currentMessage,
  budgetBytes,
  messageOverheadBytes = DEFAULT_MESSAGE_OVERHEAD_BYTES,
  envelopeOverheadBytes = DEFAULT_ENVELOPE_OVERHEAD_BYTES,
}) {
  if (!Array.isArray(history)) throw new TypeError("history must be an array");
  if (!Number.isInteger(budgetBytes) || budgetBytes <= 0) {
    throw new TypeError("budgetBytes must be a positive integer");
  }

  const fixedBytes =
    utf8Bytes(instructions) +
    utf8Bytes(currentMessage) +
    envelopeOverheadBytes +
    messageOverheadBytes;

  if (fixedBytes > budgetBytes) {
    throw new ContextBudgetError("Current turn exceeds the governed Groq input budget", {
      inputBytes: fixedBytes,
      budgetBytes,
      historyIncluded: 0,
      historyOmitted: history.length,
    });
  }

  const selected = [];
  let inputBytes = fixedBytes;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index] || {};
    const itemBytes =
      utf8Bytes(item.role) +
      utf8Bytes(item.text) +
      messageOverheadBytes;

    // Preserve one contiguous recent history window. Never skip a newer item
    // just to include an older one.
    if (inputBytes + itemBytes > budgetBytes) break;

    selected.unshift({
      role: item.role,
      text: item.text,
    });
    inputBytes += itemBytes;
  }

  return {
    history: selected,
    historyIncluded: selected.length,
    historyOmitted: history.length - selected.length,
    inputBytes,
    budgetBytes,
  };
}
