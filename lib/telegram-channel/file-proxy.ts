/**
 * Telegram file proxy — `GET /api/telegram-file/:id`.
 *
 * Why this exists: when we hand the Vercel AI Gateway a Telegram CDN
 * URL directly (`https://api.telegram.org/file/bot<TOKEN>/photos/file_X.jpg`),
 * the Gateway server fetches it server-side and rejects with
 * `Unsupported MIME type: application/octet-stream` — because
 * Telegram's CDN sometimes serves uploaded photos with that generic
 * content-type instead of `image/jpeg`. The Gateway validates against
 * the FETCHED content-type, not the FilePart's declared `mediaType`,
 * so declaring `mediaType: 'image'` on our end is not enough.
 *
 * This proxy sits between the Gateway and Telegram. The Gateway hits
 * `https://drop-mate-delta.vercel.app/api/telegram-file/<id>?exp=...&sig=...`
 * which:
 *
 *   1. Verifies the HMAC signature against the webhook secret so
 *      external callers can't enumerate `file_id`s.
 *   2. Verifies the expiry hasn't passed (10-minute TTL).
 *   3. Calls `getTelegramFileUrl(token, fileId)` + `fetch` to download
 *      the bytes from Telegram's CDN.
 *   4. Re-streams the bytes with `Content-Type: image/jpeg` — Bot API
 *      `photo[]` is always JPEG per the spec, so this is always
 *      correct for the photo path.
 *
 * Side benefit: the bot token never leaves our server. The Telegram
 * CDN URL (which contains the token) is dereferenced inside the proxy
 * handler. The signed URL we hand the Gateway contains only `fileId`,
 * `exp`, and `sig`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { getTelegramFileUrl } from "./file.js";

const DEFAULT_TTL_SECONDS = 600; // 10 minutes — Gateway fetches within seconds in practice.

/**
 * Compute the HMAC-SHA256 hex signature over `${fileId}.${expiresAt}`
 * using the webhook secret as the key. We reuse the existing webhook
 * secret rather than provisioning another secret because (a) it's
 * already environment-provisioned, (b) the threat model is the same
 * ("only the legitimate bot can construct valid URLs"), and (c) one
 * less secret to rotate.
 */
function computeSignature(
  fileId: string,
  expiresAt: number,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(`${fileId}.${expiresAt}`)
    .digest("hex");
}

/**
 * Returns a fully-qualified proxy URL the Gateway can fetch. `origin`
 * is captured from the inbound webhook's `req.url` so it works on both
 * production (`drop-mate-delta.vercel.app`) and preview deployments
 * (`drop-mate-<hash>-...vercel.app`) without an explicit env var.
 *
 * The URL embeds `exp` (unix-seconds expiry) and `sig` (HMAC hex) as
 * query params; the file id is in the path segment so the route can
 * use Ash's `:id` matcher.
 */
export function buildFileProxyUrl(
  origin: string,
  fileId: string,
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): string {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = computeSignature(fileId, expiresAt, secret);
  return `${origin}/api/telegram-file/${encodeURIComponent(fileId)}?exp=${expiresAt}&sig=${sig}`;
}

/**
 * Constant-time signature comparison. Returns false when the lengths
 * differ (a different signature shape — almost certainly hostile or
 * corrupt) so the caller can reject without timing leakage.
 */
function signaturesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Handler for `GET /api/telegram-file/:id`. Returns:
 *
 *   - 401 when the signature is missing, malformed, or doesn't match.
 *   - 410 when the URL has expired.
 *   - 502 when the upstream Telegram fetch fails (the proxy is a
 *     pass-through; we can't recover here, only diagnose).
 *   - 200 + `Content-Type: image/jpeg` + the image bytes on success.
 *
 * The proxy intentionally rewrites the content-type to `image/jpeg`
 * regardless of what Telegram returns — that's the whole point of
 * standing this proxy up. If Telegram ever serves non-JPEG photos
 * (currently the Bot API spec guarantees JPEG for `photo[]`), revisit
 * here.
 */
export interface FileProxyDeps {
  readonly token: string;
  readonly secret: string;
  /** Override for tests; defaults to `Date.now`. Seconds-since-epoch. */
  readonly now?: () => number;
  /** Override for tests; defaults to global `fetch`. */
  readonly fetch?: typeof fetch;
}

export async function handleFileProxyRequest(
  req: Request,
  fileId: string | undefined,
  deps: FileProxyDeps,
): Promise<Response> {
  if (!fileId || fileId.length === 0) {
    return new Response("missing file id", { status: 400 });
  }

  const url = new URL(req.url);
  const expParam = url.searchParams.get("exp");
  const sigParam = url.searchParams.get("sig");

  if (!expParam || !sigParam) {
    return new Response("missing exp or sig", { status: 401 });
  }

  const expiresAt = Number.parseInt(expParam, 10);
  if (!Number.isFinite(expiresAt)) {
    return new Response("invalid exp", { status: 401 });
  }

  const expected = computeSignature(fileId, expiresAt, deps.secret);
  if (!signaturesEqual(expected, sigParam)) {
    return new Response("bad signature", { status: 401 });
  }

  const nowSeconds = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  if (nowSeconds > expiresAt) {
    return new Response("expired", { status: 410 });
  }

  let telegramUrl: string;
  try {
    telegramUrl = await getTelegramFileUrl(deps.token, fileId);
  } catch (err) {
    return new Response(
      `telegram getFile failed: ${err instanceof Error ? err.message : String(err)}`,
      { status: 502 },
    );
  }

  const fetchImpl = deps.fetch ?? fetch;
  const upstream = await fetchImpl(telegramUrl);
  if (!upstream.ok) {
    return new Response(
      `telegram file download failed: ${upstream.status} ${upstream.statusText}`,
      { status: 502 },
    );
  }

  // Always `image/jpeg`: Bot API `photo[]` is JPEG by spec, and the
  // whole point of this proxy is to override Telegram's misleading
  // `application/octet-stream`.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "private, max-age=60",
    },
  });
}
