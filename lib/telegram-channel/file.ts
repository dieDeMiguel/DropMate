/**
 * Telegram Bot API file resolution.
 *
 * Resolves a `file_id` (the opaque pointer Telegram hands us on every
 * `photo[]` / `document` / `audio` update) into either a downloadable
 * HTTPS URL (`getTelegramFileUrl`) or the actual bytes plus media type
 * (`fetchTelegramFile`) via the two-step `getFile` dance:
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
 * Why prefer `fetchTelegramFile` over `getTelegramFileUrl` for
 * multimodal model input: the download URL embeds the bot token. Some
 * AI Gateway routes reject credential-bearing URLs, and AI SDK 7
 * multimodal parts work most reliably when the bytes are inline with
 * an explicit `mediaType`, packaged as a `FilePart`
 * ({ type: "file", data: bytes, mediaType }). The legacy `ImagePart`
 * shape is deprecated and the Vercel AI Gateway rejects the data: URI
 * the SDK serializes it to ("Unsupported file URI type").
 * `getTelegramFileUrl` stays exported because `verify.ts` / future
 * flows that DM the user a link may still need it.
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

/**
 * Inlined Telegram file — the bytes plus the `content-type` header the
 * Telegram file CDN returned. Passed straight into AI SDK 7 multimodal
 * `FilePart` ({ type: "file", data: bytes, mediaType }) so the model
 * provider doesn't have to fetch a credential-bearing URL.
 */
export interface FetchedTelegramFile {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

/**
 * Resolves a `file_id` to the file's bytes + media type by chaining
 * `getTelegramFileUrl` with a server-side fetch. Keeps the bot token
 * inside this module — the bytes that flow out are credential-free.
 *
 * Falls back to `image/jpeg` when the CDN omits `content-type`, which
 * matches Telegram's behaviour for photos uploaded from the mobile
 * client. Callers that need a stricter mode can read `mediaType` and
 * reject themselves.
 */
export async function fetchTelegramFile(
  token: string,
  fileId: string,
): Promise<FetchedTelegramFile> {
  const url = await getTelegramFileUrl(token, fileId);
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Telegram file download failed: ${res.status} ${res.statusText} ${body}`,
    );
  }
  const mediaType = res.headers.get("content-type") ?? "image/jpeg";
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, mediaType };
}
