export function buildVerdict(compactVerdict, finalVerdict, conditions, commandResults) {
  return {
    ...compactVerdict,
    final_verdict: finalVerdict,
    conditions,
    summary: "verifier summary"
  };
}

export function renderMarkdownReport(verdict) {
  return [
    `Confidence: ${verdict.confidence}`,
    `Risk: ${verdict.risk}`,
    `Compatibility verdict: ${verdict.verdict}`
  ].join("\n");
}
