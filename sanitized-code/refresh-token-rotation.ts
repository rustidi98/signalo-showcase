/**
 * Refresh-token rotation with device-bound reuse detection (sanitized extract)
 * ----------------------------------------------------------------------------
 * "False logout" — a user booted out of the app mid-session despite holding a
 * valid session — was the most expensive recurring bug in the product's history.
 * It came back eight times. Almost never was the server actually wrong; the bug
 * was in how the client and server disagreed about what a *dead* session is.
 *
 * A mobile client holds a short-lived access token and an opaque refresh token.
 * The refresh token ROTATES on every use: present it, get a new one, the old one
 * is now spent. Rotation is the right security posture (a leaked token is only
 * good until the next refresh) — but it creates a classic ambiguity:
 *
 *   The client calls /auth/refresh. The server rotates and sends the new token.
 *   The response is lost on a flaky link. The client retries with the SAME
 *   (now-spent) token. Is this an honest retry, or an attacker replaying a
 *   stolen token?
 *
 * The first version answered with a 60-second time window: a replay within 60s of
 * rotation is a retry, otherwise it's theft → revoke the whole chain and force a
 * re-login. On a flaky mobile network a stall longer than 60s is normal, so a
 * legitimate retry past the window nuked the session. That was the false logout.
 *
 * The fix replaces the fragile time window with DEVICE IDENTITY. A spent token
 * replayed from the same device is *always* a lost-response retry — re-issue it,
 * never log out, no matter how much time passed. Only a spent token replayed from
 * a DIFFERENT device is a genuine reuse → revoke the chain (RFC 6819). The single
 * real defence against a lost/stolen phone is the biometric/passcode gate on the
 * client, not a short token lifetime.
 *
 * Sanitized: header names, prefixes, and ticket numbers changed; logic unchanged.
 */

import { createHash, randomBytes } from "node:crypto";

/** Refresh token lifetime. Rotation re-stamps the expiry on EVERY refresh, so an
 *  active daily user's session is effectively perpetual; the TTL only fires after
 *  a full year of not opening the app. A short TTL was itself a source of false
 *  logouts (a user away for a couple of months got a hard logout). */
export const REFRESH_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** Opaque refresh token. The plaintext is returned to the client exactly once. */
export function createRefreshToken(): string {
  return `rt_${randomBytes(48).toString("base64url")}`;
}

/** Only the sha256 hash is ever stored — plaintext never touches the database. */
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

type RefreshRow = {
  id: string;
  userId: string;
  deviceId: string | null;
  rotatedTo: string | null; // set once this token is spent → points at its successor
  expiresAt: Date;
  revokedAt: Date | null;
};

export type RefreshOutcome =
  | { kind: "rotated"; accessToken: string; refreshToken: string }
  | { kind: "reissued"; accessToken: string; refreshToken: string } // lost-response retry
  | { kind: "revoked" }; // genuine reuse — the only path that ends the session

/**
 * The core decision. `presentedDeviceId` is null for web and legacy clients,
 * which are treated leniently (there's no device to compare against).
 */
export async function handleRefresh(
  presentedToken: string,
  presentedDeviceId: string | null,
  store: RefreshTokenStore,
): Promise<RefreshOutcome> {
  const row = await store.findByHash(hashRefreshToken(presentedToken));

  // Unknown or expired token → nothing to reissue. Honest end of session.
  if (!row || row.expiresAt.getTime() < Date.now()) return { kind: "revoked" };

  // Live head token → the normal path: rotate it.
  if (!row.rotatedTo && !row.revokedAt) {
    return store.rotate(row); // issue successor, re-stamp expiry, spend this one
  }

  // Spent or revoked token presented again → disambiguate retry vs replay.
  const sameDevice =
    row.deviceId === null || // legacy: no device binding, treat as a retry
    presentedDeviceId === null ||
    row.deviceId === presentedDeviceId;

  if (sameDevice) {
    // A dropped response on a flaky link. Re-issue the CURRENT head of the chain
    // so the client converges. Never log out — no matter how long ago it rotated.
    return store.reissueHeadFor(row); // idempotent lost-response recovery
  }

  // Same spent token, DIFFERENT device → a real reuse. Revoke the whole chain so
  // a stolen token can't be walked forward, and force an honest re-login.
  await store.revokeChain(row);
  return { kind: "revoked" };
}

export interface RefreshTokenStore {
  findByHash(hash: string): Promise<RefreshRow | null>;
  rotate(row: RefreshRow): Promise<RefreshOutcome>;
  reissueHeadFor(row: RefreshRow): Promise<RefreshOutcome>;
  revokeChain(row: RefreshRow): Promise<void>;
}
