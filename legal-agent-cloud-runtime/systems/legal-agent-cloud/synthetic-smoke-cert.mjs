const REQUIRED_SECTIONS = Object.freeze([
  "TERMINATION_CLASSIFICATION",
  "PENALTY_NATURE",
  "SUPPLEMENTARY_DAMAGES",
  "LIMITATION_CLASSIFICATION",
  "FIXED_TERM_SERVICE_RULE",
  "COUNTER_APPLICABILITY",
]);

export function syntheticSmokeRequiredSections() {
  return [...REQUIRED_SECTIONS];
}

export function findSyntheticSmokeCoverageGap(answer) {
  const raw = String(answer || "");
  const upper = raw.toUpperCase();

  for (const section of REQUIRED_SECTIONS) {
    const marker = `[${section}]`;
    const index = upper.indexOf(marker);
    if (index < 0) return `missing_section:${section.toLowerCase()}`;

    const contentStart = index + marker.length;
    const nextMarkerPositions = REQUIRED_SECTIONS
      .map((candidate) => upper.indexOf(`[${candidate}]`, contentStart))
      .filter((position) => position >= 0);
    const contentEnd = nextMarkerPositions.length ? Math.min(...nextMarkerPositions) : raw.length;
    const content = raw.slice(contentStart, contentEnd).replace(/\s+/g, " ").trim();
    if (content.length < 20) return `empty_section:${section.toLowerCase()}`;
  }

  if (!upper.includes("AUTHORITY_CHECK_REQUIRED")) {
    return "missing_authority_check_required";
  }

  return null;
}
