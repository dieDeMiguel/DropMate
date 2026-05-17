/**
 * Telegram Bot API file resolution.
 *
 * Resolves a `file_id` (the opaque pointer Telegram hands us on every
 * `photo[]` / `document` / `audio` update) into a downloadable HTTPS
 * URL via the two-step `getFile` dance:
 *
 *   1. `POST /bot<token>/getFile` with `file_id` → response has
 *      `result.file_path` (e.g. `photos/file_42.jpg`).
 *   2. The downloadable URL is then literally
 *      `https://api.telegram.org/file/bot<token>/<file_path>`.
 *
 * The token is an explicit argument (same convention as `send.ts`) so
 * tests don't have to monkey-patch `process.env` and the Phase 2
 * `telegramChannel({ token, ... })` factory can capture it in closure.
 *
 * Note on the token-in-URL: the returned URL embeds the bot token.
 * The orchestrator hands it to the multimodal model provider, which
 * fetches it server-side — the URL never reaches the end user. If
 * production logs make this too leaky, swap to a fetch + base64
 * transform here without changing the orchestrator's call site.
 *
 * @see https://core.telegram.org/bots/api#getfile
 */

interface GetFileResponse {
  readonly ok?: boolean;
  readonly result?: {
    readonly file_id?: string;
    readonly file_path?: string;
  };
  readonly description?: string;
}

export async function getTelegramFileUrl(
  token: string,
  fileId: string,
): Promise<string> {
  if (token.length === 0) {
    throw new Error("Telegram bot token is empty.");
  }
  if (fileId.length === 0) {
    throw new Error("Telegram file_id is empty.");
  }

  const res = await fetch(
    `https://api.telegram.org/bot${token}/getFile`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Telegram getFile failed: ${res.status} ${res.statusText} ${body}`,
    );
  }

  const payload = (await res.json()) as GetFileResponse;
  const filePath = payload.result?.file_path;
  if (!filePath || filePath.length === 0) {
    throw new Error(
      `Telegram getFile returned no file_path: ${JSON.stringify(payload)}`,
    );
  }

  return `https://api.telegram.org/file/bot${token}/${filePath}`;
}
