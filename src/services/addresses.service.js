import { toAddressDto } from "../models/commerce.model.js";
import { forbidden, notFound } from "../utils/errors.js";

/** A customer's own delivery addresses. Every operation is scoped to the caller — there is no "any user's address" lookup. */
export function createAddressesService({ pool, withTx, repos }) {
  const { addresses: repo } = repos;

  return {
    async list(userId) { return (await repo.list(pool, userId)).map(toAddressDto); },

    async create(userId, body) {
      return withTx(async (db) => {
        if (body.isDefault) await repo.clearDefault(db, userId);
        const existing = await repo.list(db, userId);
        const row = await repo.insert(db, userId, { ...body, isDefault: body.isDefault || existing.length === 0 });
        return toAddressDto(row);
      });
    },

    async update(userId, id, body) {
      return withTx(async (db) => {
        if (!(await repo.get(db, userId, id))) throw notFound("ADDRESS_NOT_FOUND", "Address not found");
        if (body.isDefault) await repo.clearDefault(db, userId);
        const row = await repo.update(db, userId, id, body);
        if (!row) throw notFound("ADDRESS_NOT_FOUND", "Address not found");
        return toAddressDto(row);
      });
    },

    async setDefault(userId, id) {
      return withTx(async (db) => {
        if (!(await repo.get(db, userId, id))) throw notFound("ADDRESS_NOT_FOUND", "Address not found");
        await repo.clearDefault(db, userId);
        return toAddressDto(await repo.setDefault(db, userId, id));
      });
    },

    async remove(userId, id) {
      if (!(await repo.remove(pool, userId, id))) throw notFound("ADDRESS_NOT_FOUND", "Address not found");
      return { id };
    },
  };
}
