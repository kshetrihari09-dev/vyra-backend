import { createHmac } from "node:crypto";

/**
 * ICE servers for one browser, built on the server so the TURN secret never leaves it.
 * TURN credentials follow coturn's `use-auth-secret` REST scheme: username = "<expiryUnix>:<userId>",
 * credential = base64(HMAC-SHA1(secret, username)). They stop working at the expiry, so a leaked one is short-lived.
 */
export function buildIceServers({ calls }, userId, now = Date.now()) {
  const servers = [];
  if (calls.stunUrls.length) servers.push({ urls: calls.stunUrls });
  if (calls.turnUrls.length && calls.turnSecret) {
    const expires = Math.floor(now / 1000) + calls.turnTtlSeconds;
    const username = `${expires}:${userId}`;
    const credential = createHmac("sha1", calls.turnSecret).update(username).digest("base64");
    servers.push({ urls: calls.turnUrls, username, credential });
  }
  return { iceServers: servers, relay: calls.turnUrls.length > 0, expiresInSeconds: calls.turnUrls.length ? calls.turnTtlSeconds : null };
}
