/**
 * `classify_message` — cheap binary classifier: is this message about a
 * package coordination event (received / picked up / search / "I'm not
 * home"), or is it social/off-topic chat that the agent should ignore?
 *
 * Use this on every group message before deciding whether to call
 * `register_package`, `lookup_package`, or any other domain tool. In
 * 1:1 DMs the model can usually skip this (the user is talking to the
 * bot directly), but it's still safe to call.
 *
 * Routed through Vercel AI Gateway with `sort: 'cost'` so the cheapest
 * provider serving Gemini 2.5 Flash wins. Returns a `reason` string so
 * the orchestrating model can log / explain its decision.
 */

import { defineTool } from "experimental-ash/tools";
import { generateObject } from "ai";
import { z } from "zod";

const CLASSIFY_MODEL = "google/gemini-2.5-flash";

const inputSchema = z.object({
  text: z
    .string()
    .min(1)
    .describe(
      "The message text to classify. Pass the full text the resident sent, " +
        "in its original language.",
    ),
});

const outputSchema = z.object({
  isPackageRelated: z
    .boolean()
    .describe(
      "True iff the message is about a package being received, held for " +
        "a neighbor, picked up, searched for, or expected (incl. 'I'm not " +
        "home tomorrow').",
    ),
  reason: z
    .string()
    .describe(
      "One short sentence explaining the classification — used for logs " +
        "and so the parent model can reason about edge cases.",
    ),
});

const classificationPrompt = [
  "You are a binary classifier for a neighbor-coordination bot.",
  "",
  "Decide whether the message is about PACKAGE COORDINATION:",
  "  - a package was received and is being held for a neighbor",
  '  - "Paket für X", "Pakete für X und Y", "Habe X\'s Päckchen"',
  '  - a package was picked up ("Picked up, thanks", "Habe abgeholt")',
  '  - someone is asking where their package is',
  '  - someone says they will not be home and expects a package',
  "",
  "Everything else is NOT package-related:",
  "  - party invitations, event flyers, social chat",
  "  - building maintenance, complaints, lost cats, weather",
  '  - general greetings or banter',
  "",
  'Return JSON like {"isPackageRelated": true|false, "reason": "..."}.',
  "Keep `reason` to one short sentence in English.",
].join("\n");

export default defineTool({
  description:
    "Classify a single message as package-related or not. Call this on " +
    "group messages BEFORE deciding to register / look up / confirm a " +
    "package. Returns `{ isPackageRelated, reason }`. Cheap (Gemini Flash " +
    "via AI Gateway with cost-sorted routing). When `isPackageRelated` is " +
    "false, do nothing — do not reply to the group.",
  inputSchema,
  async execute({ text }) {
    const { object } = await generateObject({
      model: CLASSIFY_MODEL,
      schema: outputSchema,
      system: classificationPrompt,
      prompt: text,
      providerOptions: {
        gateway: {
          sort: "cost",
        },
      },
    });
    return object;
  },
});
