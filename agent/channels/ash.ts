import { ashChannel } from "experimental-ash/channels/ash";
import { vercelOidc } from "experimental-ash/channels/auth";

/**
 * Built-in Ash session protocol channel.
 *
 * Mounted at `/ash/v1/session*`. Used by the Ash dev client and by the
 * Phase 1 thin Telegram webhook (`lib/telegram/webhook.ts`) to drive the
 * agent for local testing before the native Telegram channel lands in
 * Phase 2 (issue #19).
 *
 * `vercelOidc()` is the right default on Vercel: the deployment's own
 * runtime can call the session API with its `VERCEL_OIDC_TOKEN`, which
 * the framework auto-detects. The same path covers the thin Telegram
 * webhook because it runs inside the same Vercel deployment.
 */
export default ashChannel({
  auth: vercelOidc(),
});
