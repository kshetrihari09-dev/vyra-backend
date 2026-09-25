import { clientContext, ok } from "../utils/http.js";

export function createUsersController({ services }) {
  const { users } = services;
  return {
    async list(req, res) { ok(res, await users.list(req.valid.query)); },
    async get(req, res) { ok(res, { user: await users.get(req.valid.params.id) }); },
    async listRoles(_req, res) { ok(res, { roles: await users.listRoles() }); },
    async setStatus(req, res) {
      ok(res, { user: await users.setStatus(req.auth.user, req.valid.params.id, req.valid.body, clientContext(req)) });
    },
    async setRoles(req, res) {
      ok(res, { user: await users.setRoles(req.auth.user, req.valid.params.id, req.valid.body.roles, clientContext(req)) });
    },
  };
}
