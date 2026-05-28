/**
 * Repair helpers for structured-output (`generateObject`) call sites.
 *
 * Some providers — most often the Claude Sonnet fallback under load, or
 * when a verbose system prompt nudges them toward "explain your answer"
 * mode — wrap their JSON output in markdown fences (` ```json … ``` `)
 * or sandwich it between lead-in / trailing prose. The AI SDK's JSON
 * parser then throws before any retry can run.
 *
 * `repairJsonText` is the 12-line stripper wired into each
 * `generateObject` call's `experimental_repairText` hook (see the three
 * channel-deterministic tools in `agent/tools/`). The repair is
 * defensive — no JSON parsing inside; `generateObject` keeps that job.
 *
 * Strategy:
 *   1. Trim surrounding whitespace.
 *   2. Strip an outer ` ```json … ``` ` (or ` ``` … ``` `) fence with a
 *      regex. The closing fence may include trailing whitespace.
 *   3. Slice from the first `{` to the last `}` so any lead-in
 *      ("Here is the JSON:") or trailing ("Hope that helps!") prose
 *      around an object payload is removed.
 *
 * The helper returns the repaired string. Callers that need the
 * `experimental_repairText` shape can use `repairFencedJson` directly —
 * it wraps `repairJsonText` and returns `Promise<string | null>` per
 * the AI SDK contract.
 */

const FENCE_REGEX = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i;

export function repairJsonText(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = FENCE_REGEX.exec(trimmed);
  const unfenced = fenceMatch ? fenceMatch[1].trim() : trimmed;
  const firstBrace = unfenced.indexOf("{");
  const lastBrace = unfenced.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    return unfenced;
  }
  return unfenced.slice(firstBrace, lastBrace + 1);
}

/**
 * AI SDK `experimental_repairText` adapter. The SDK calls this with
 * the raw model output when JSON parsing or schema validation throws;
 * we run `repairJsonText` and hand the cleaned string back so the SDK
 * can retry the parse. Returning `null` would tell the SDK the text
 * is unrepairable — we always return a string because the stripper is
 * idempotent on already-clean JSON.
 */
export async function repairFencedJson({
  text,
}: {
  text: string;
}): Promise<string | null> {
  return repairJsonText(text);
}
