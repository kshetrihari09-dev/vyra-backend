import { clientContext, ok } from "../utils/http.js";

/** Controllers are thin: validated input in, service call, response out. */
export function createAuthController({ services, config }) {
  const { auth } = services;
  const cookieOptions = (expires) => ({
    httpOnly: true,
    secure: config.cookie.secure,
    sameSite: "strict",
    path: "/api/auth",
    domain: config.cookie.domain,
    ...(expires ? { expires } : {}),
  });
  const setRefreshCookie = (res, token, expiresAt) => res.cookie(config.cookie.name, token, cookieOptions(expiresAt));
  const clearRefreshCookie = (res) => res.clearCookie(config.cookie.name, cookieOptions());
  const sessionResponse = (res, s, status = 200) => {
    setRefreshCookie(res, s.refreshToken, s.refreshExpiresAt);
    return ok(res, { user: s.user, accessToken: s.accessToken, expiresInSeconds: config.auth.accessTtlSeconds }, status);
  };

  return {
    async registerStart(req, res) {
      const data = await auth.registerStart(req.valid.body, clientContext(req));
      const body = { ...data };
      if (config.otp.devCode) body.devHint = "Development OTP is active"; // never the code itself
      ok(res, body, 202);
    },
    async registerVerify(req, res) {
      sessionResponse(res, await auth.registerVerify(req.valid.body, clientContext(req)), 201);
    },
    async login(req, res) {
      sessionResponse(res, await auth.login(req.valid.body, clientContext(req)));
    },
    async refresh(req, res) {
      try {
        sessionResponse(res, await auth.refresh(req.cookies?.[config.cookie.name], clientContext(req)));
      } catch (err) {
        if (err.code !== "REFRESH_TOKEN_ROTATED") clearRefreshCookie(res); // keep the winner's fresh cookie in the race case
        throw err;
      }
    },
    async logout(req, res) {
      await auth.logout(req.cookies?.[config.cookie.name]);
      clearRefreshCookie(res);
      ok(res, { loggedOut: true });
    },
    async logoutAll(req, res) {
      await auth.logoutAll(req.auth.user.id);
      clearRefreshCookie(res);
      ok(res, { loggedOut: true });
    },
    async me(req, res) {
      ok(res, { user: await auth.me(req.auth.user.id) });
    },
    async forgotPassword(req, res) {
      await auth.forgotPassword(req.valid.body, clientContext(req));
      ok(res, { message: "If an account exists, we've sent instructions to reset the password." }, 202);
    },
    async resetPassword(req, res) {
      await auth.resetPassword(req.valid.body, clientContext(req));
      ok(res, { message: "Password updated. Please sign in." });
    },
    async changePassword(req, res) {
      const s = await auth.changePassword(req.auth.user.id, req.valid.body, clientContext(req));
      setRefreshCookie(res, s.refreshToken, s.refreshExpiresAt);
      ok(res, { accessToken: s.accessToken, expiresInSeconds: config.auth.accessTtlSeconds });
    },
  };
}
