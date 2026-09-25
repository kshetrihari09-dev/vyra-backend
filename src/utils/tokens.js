import jwt from "jsonwebtoken";

/**
 * Access tokens are short-lived JWTs carrying ONLY the user id. Roles and
 * permissions are looked up in the database on every request (see
 * middleware/authenticate.js), so a role change or suspension takes effect
 * immediately and nothing security-relevant is trusted from the token.
 */
export function createTokenService({ secret, ttlSeconds, issuer = "vyra-api", audience = "vyra-web" }) {
  return {
    signAccessToken(userId) {
      return jwt.sign({}, secret, { algorithm: "HS256", subject: userId, issuer, audience, expiresIn: ttlSeconds });
    },
    /** @returns {{ userId: string } | null} */
    verifyAccessToken(token) {
      try {
        const payload = jwt.verify(token, secret, { algorithms: ["HS256"], issuer, audience });
        return typeof payload.sub === "string" ? { userId: payload.sub } : null;
      } catch {
        return null;
      }
    },
  };
}
