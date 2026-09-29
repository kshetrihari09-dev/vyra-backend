import { ok } from "../utils/http.js";

export function createNotificationsController({ services }) {
  const { notifications, audit } = services;
  return {
    async list(req, res) { ok(res, await notifications.list(req.auth.user, req.valid.query)); },
    async read(req, res) { ok(res, await notifications.markRead(req.auth.user, req.valid.params.id)); },
    async readAll(req, res) { ok(res, await notifications.markAllRead(req.auth.user)); },
    async getPrefs(req, res) { ok(res, { preferences: await notifications.getPreferences(req.auth.user) }); },
    async setPrefs(req, res) { ok(res, { preferences: await notifications.setPreferences(req.auth.user, req.valid.body) }); },
    async auditLog(req, res) { ok(res, await audit.query(req.auth.user, req.valid.query)); },
  };
}
