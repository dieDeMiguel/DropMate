/**
 * `find_available_neighbors` — pick a handful of neighbors who could
 * receive a package on the caller's behalf when the caller won't be
 * home.
 *
 * Phase 1 spike heuristic: scan every Resident on the caller's
 * street, drop the caller themselves, sort by house-number proximity
 * (closest neighbours first), and return the top N (default 3, capped
 * at 3 — see PRD §5 Flow 2 "DMs 1–3 candidate neighbors").
 *
 * `availabilityPatterns` is forwarded so the model can include it in
 * the DM it sends each candidate, but the tool itself does NOT filter
 * on it: in the spike, most residents have no patterns yet. The future
 * temporal-availability filter (PRD §6 passive learning) plugs in here
 * without changing the tool's surface.
 *
 * Privacy: the returned shape exposes only `id`, `name`, `houseNumber`,
 * and `availabilityPatterns`. `platformId`, `floor`, `buzzerName`,
 * `language` etc. stay private — the model uses the candidate `id` as
 * input to `notify_recipient`, which loads the full Resident itself.
 */

import { defineTool } from "experimental-ash/tools";
import { z } from "zod";

import { requireRegisteredTelegramCaller } from "../../lib/auth.js";
import { listResidentsForStreet, type Resident } from "../../lib/redis.js";

export interface Candidate {
  readonly id: string;
  readonly name: string;
  readonly houseNumber: string;
  readonly availabilityPatterns: readonly string[];
}

function summariseCandidate(resident: Resident): Candidate {
  return {
    id: resident.id,
    name: resident.name,
    houseNumber: resident.houseNumber,
    availabilityPatterns: resident.availabilityPatterns,
  };
}

/**
 * Parses leading digits off a house number string. "12B" → 12,
 * "88" → 88, "abc" → NaN. Used to rank candidates by adjacency to
 * the caller's own house; non-numeric strings are treated as
 * infinitely-far so they sort to the end.
 */
function houseNumberAsInt(s: string): number {
  const m = s.match(/^\d+/);
  if (!m) return Number.NaN;
  return Number(m[0]);
}

function distance(a: string, b: string): number {
  const ai = houseNumberAsInt(a);
  const bi = houseNumberAsInt(b);
  if (Number.isNaN(ai) || Number.isNaN(bi)) return Number.POSITIVE_INFINITY;
  return Math.abs(ai - bi);
}

const MAX_CANDIDATES = 3;

const inputSchema = z.object({
  max: z
    .number()
    .int()
    .min(1)
    .max(MAX_CANDIDATES)
    .optional()
    .describe(
      "Maximum number of candidates to return (1..3). Defaults to 3. " +
        "Use a smaller number when the recipient only wants the closest " +
        "neighbor pinged.",
    ),
});

export default defineTool({
  description:
    "Find 1–3 neighbors on the caller's street who could receive a " +
    "package on the caller's behalf. Excludes the caller. Ranks by " +
    "house-number adjacency (closest first). Returns " +
    "`{ candidates, count }` where each candidate is " +
    "`{ id, name, houseNumber, availabilityPatterns }`. Pass each " +
    "candidate's `id` to `notify_recipient` to DM the ask, then call " +
    "`create_reception_request` with the full `candidateResidentIds` " +
    "list so the request can later be matched to a volunteer's " +
    "response.",
  inputSchema,
  async execute({ max }) {
    const caller = await requireRegisteredTelegramCaller(
      "find_available_neighbors",
    );

    const all = await listResidentsForStreet(caller.street);
    const candidates = all
      .filter((r) => r.id !== caller.id)
      .map((r) => ({ resident: r, d: distance(r.houseNumber, caller.houseNumber) }))
      .sort((a, b) => {
        if (a.d !== b.d) return a.d - b.d;
        return a.resident.id.localeCompare(b.resident.id);
      })
      .slice(0, max ?? MAX_CANDIDATES)
      .map(({ resident }) => summariseCandidate(resident));

    return {
      candidates: candidates as readonly Candidate[],
      count: candidates.length,
    };
  },
});
