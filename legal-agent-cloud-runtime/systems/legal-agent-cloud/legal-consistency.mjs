function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function matchPositions(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => ({
    index: match.index ?? -1,
    end: (match.index ?? -1) + String(match[0] || "").length,
  }));
}

function nearestDistance(index, positions) {
  let best = Number.POSITIVE_INFINITY;
  for (const pos of positions) {
    if (pos.index < 0) continue;
    best = Math.min(best, Math.abs(index - pos.index));
  }
  return best;
}

function hasArticle205FiveYearMismatch(normalized) {
  const article205 = matchPositions(normalized, /\bart\.?\s*205\b/g);
  const article206 = matchPositions(normalized, /\bart\.?\s*206\b/g);
  const fiveYears = matchPositions(normalized, /\b(?:5|cinco)\s+anos\b/g);
  if (!article205.length || !fiveYears.length) return false;

  for (const five of fiveYears) {
    const d205 = nearestDistance(five.index, article205);
    const d206 = nearestDistance(five.index, article206);
    if (d205 > 180 || d206 < d205) continue;

    const nearest205 = article205.reduce((best, current) =>
      Math.abs(five.index - current.index) < Math.abs(five.index - best.index) ? current : best,
    );
    const start = Math.max(0, Math.min(nearest205.index, five.index) - 60);
    const end = Math.min(normalized.length, Math.max(nearest205.end, five.end) + 100);
    const context = normalized.slice(start, end);

    const expresslyCorrected =
      /\b(?:nao|nunca)\b.{0,100}\b(?:5|cinco)\s+anos\b/.test(context) ||
      /\bart\.?\s*205\b.{0,100}\b(?:10|dez)\s+anos\b/.test(context);
    if (!expresslyCorrected) return true;
  }
  return false;
}

export function findLegalConsistencyViolation(answer) {
  const normalized = normalize(answer);

  if (hasArticle205FiveYearMismatch(normalized)) {
    return "cc_art_205_five_year_mismatch";
  }

  const mentionsPenalty = /\b(?:multa|clausula penal)\b/.test(normalized);
  const mentionsDamages = /\bperdas e danos\b|\blucros cessantes\b/.test(normalized);
  const claimsCumulative =
    /\b(?:alem|cumul|somad)[a-z]*\b.{0,80}\b(?:multa|clausula penal|perdas e danos|lucros cessantes)\b/.test(normalized) ||
    /\b(?:multa|clausula penal)\b.{0,100}\b(?:alem|cumul|somad)[a-z]*\b.{0,80}\b(?:perdas e danos|lucros cessantes)\b/.test(normalized);
  const addressesSupplementalRule =
    /\bart\.?\s*416\b/.test(normalized) ||
    /\bindenizacao suplementar\b/.test(normalized) ||
    /\bprevisao contratual expressa\b/.test(normalized) ||
    /\breserva contratual expressa\b/.test(normalized) ||
    /\bnatureza (?:moratoria|compensatoria)\b/.test(normalized);
  if (mentionsPenalty && mentionsDamages && claimsCumulative && !addressesSupplementalRule) {
    return "penalty_supplemental_damages_unqualified";
  }

  const lawAsFact =
    /\bfundamento legal\b.{0,180}\bverified_fact\b/.test(normalized) ||
    /\b(?:art|lei|sumula|tema)\b.{0,140}\bverified_fact\b/.test(normalized);
  if (lawAsFact) return "authority_mislabeled_as_verified_fact";

  return null;
}
