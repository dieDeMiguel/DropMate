/**
 * `register_resident` — writes a Resident record to Redis for the caller.
 *
 * Use when a resident sends `/register …` or asks in freeform text to be
 * added to the directory (PRD §6 explicit registration). The model
 * extracts `{ name, street, houseNumber, floor?, buzzerName? }` from the
 * user's message — works in any language because the model is the
 * parser — and calls this tool with the structured fields.
 *
 * The caller's `platformId` is taken from session auth (the Telegram
 * webhook sets `principalId = telegramUserId`), so the model does not
 * need to pass it in. Re-running for the same `platformId` updates the
 * record (idempotent), preserving `availabilityPatterns` and the
 * `language` learned from earlier DMs.
 */

import { defineTool } from "experimental-ash/tools";
import { getSession } from "experimental-ash/context";
import { z } from "zod";

import { getResident, setResident, type Resident } from "../../lib/redis.js";

const inputSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe("Full name as the resident wrote it, e.g. 'Anna-Sophie Meyer'."),
  street: z
    .string()
    .min(1)
    .describe("Street name without the house number, e.g. 'Methfesselstraße'."),
  houseNumber: z
    .string()
    .min(1)
    .describe("House number with any suffix, e.g. '92', '92a', '10-12'."),
  floor: z
    .string()
    .min(1)
    .optional()
    .describe("Floor/Etage if the resident provided one, e.g. 'III. Etage', 'EG', '5. OG'."),
  buzzerName: z
    .string()
    .min(1)
    .optional()
    .describe("Name on the buzzer if different from the resident's name, e.g. 'Hartmann'."),
});

export default defineTool({
  description:
    "Register the calling resident in the street directory. Use when the user " +
    "sends `/register …` or otherwise asks (in any language) to be added so " +
    "neighbors can hand them packages. The caller is identified by their " +
    "session auth — do not ask the user for an ID. Returns the stored " +
    "Resident record.",
  inputSchema,
  async execute({ name, street, houseNumber, floor, buzzerName }) {
    const session = getSession();
    const principal = session.auth.current ?? session.auth.initiator;
    if (!principal || principal.authenticator !== "telegram") {
      throw new Error(
        "register_resident requires a Telegram-authenticated caller; " +
          "got authenticator=" +
          (principal?.authenticator ?? "<none>"),
      );
    }
    const platformId = principal.principalId;
    const languageCode = pickLanguageCode(principal.attributes.languageCode);

    const existing = await getResident(platformId);
    const resident: Resident = {
      id: existing?.id ?? platformId,
      name,
      street,
      houseNumber,
      floor,
      buzzerName,
      platformId,
      platform: "telegram",
      language: existing?.language ?? languageCode,
      availabilityPatterns: existing?.availabilityPatterns ?? [],
      registeredAt: existing?.registeredAt ?? Date.now(),
      source: "explicit",
      confirmed: true,
    };

    await setResident(resident);
    return { resident, updated: existing !== null };
  },
});

function pickLanguageCode(
  attr: string | readonly string[] | undefined,
): string | undefined {
  if (typeof attr === "string") return attr;
  if (Array.isArray(attr) && attr.length > 0) return attr[0];
  return undefined;
}
