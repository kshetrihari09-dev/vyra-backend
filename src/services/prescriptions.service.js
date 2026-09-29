import { toPrescriptionDto } from "../models/prescriptions.model.js";
import { badRequest, conflict, forbidden, notFound } from "../utils/errors.js";
import { newStorageKey } from "./storage.service.js";

const can = (actor, perm) => !!actor?.permissions?.includes(perm);

export function createPrescriptionsService({ pool, withTx, repos, storage, audit, notifications = { emit: async () => null } }) {
  const repo = repos.prescriptions;

  async function hydrate(db, row) {
    return toPrescriptionDto(row, { items: await repo.items(db, row.id) });
  }

  return {
    async upload(actor, { fileName, mimeType, buffer, productIds }, ctx) {
      return withTx(async (db) => {
        const items = productIds?.length ? productIds : await repos.products.prescriptionRequiredIds(db);
        const key = newStorageKey();
        await storage.putObject(key, buffer);
        const row = await repo.insert(db, { userId: actor.id, fileKey: key, fileName, mimeType, sizeBytes: buffer.length });
        await repo.insertItems(db, row.id, items);
        await audit.log({ actor, action: "prescription.uploaded", entityType: "prescription", entityId: row.id, newValue: { fileName, items } }, ctx, db);
        return hydrate(db, row);
      });
    },

    async listMine(actor) {
      const rows = await repo.listMine(pool, actor.id);
      const itemsByRx = await repo.itemsFor(pool, rows.map((r) => r.id));
      return rows.map((r) => toPrescriptionDto(r, { items: itemsByRx.get(r.id) ?? [] }));
    },

    async listAll(actor, { status } = {}) {
      if (!can(actor, "prescriptions:read_all")) throw forbidden();
      const rows = await repo.listAll(pool, { status });
      const itemsByRx = await repo.itemsFor(pool, rows.map((r) => r.id));
      return rows.map((r) => toPrescriptionDto(r, { items: itemsByRx.get(r.id) ?? [] }));
    },

    async get(actor, id) {
      const row = await repo.getById(pool, id);
      if (!row) throw notFound("PRESCRIPTION_NOT_FOUND", "Prescription not found");
      if (row.user_id !== actor.id && !can(actor, "prescriptions:read_all")) throw notFound("PRESCRIPTION_NOT_FOUND", "Prescription not found");
      return hydrate(pool, row);
    },

    /** Streams the file itself — gated the same way as get(): owner, or staff who can review/read every prescription. */
    async getFile(actor, id) {
      const row = await repo.getById(pool, id);
      if (!row) throw notFound("PRESCRIPTION_NOT_FOUND", "Prescription not found");
      if (row.user_id !== actor.id && !can(actor, "prescriptions:read_all") && !can(actor, "prescriptions:review")) throw notFound("PRESCRIPTION_NOT_FOUND", "Prescription not found");
      const buffer = await storage.getObject(row.file_key);
      return { buffer, mimeType: row.mime_type, fileName: row.file_name };
    },

    /** Only a pharmacist (prescriptions:review) decides — every decision is audited with their name. */
    async review(actor, id, body, ctx) {
      if (!can(actor, "prescriptions:review")) throw forbidden();
      return withTx(async (db) => {
        const row = await repo.getById(db, id);
        if (!row) throw notFound("PRESCRIPTION_NOT_FOUND", "Prescription not found");
        if (row.status !== "pending") throw conflict("ALREADY_REVIEWED", `This prescription was already "${row.status}"`);
        const updated = await repo.review(db, id, {
          status: body.status,
          notes: body.notes ?? null,
          rejectionReason: body.status === "rejected" ? (body.notes || "Prescription unclear or expired.") : null,
          pharmacistId: actor.id,
        });
        await audit.log({ actor, action: `prescription.${body.status}`, entityType: "prescription", entityId: id, newValue: { status: body.status, notes: body.notes } }, ctx, db);
        await notifications.emit(db, { userId: row.user_id, type: `prescription.${body.status}`, data: { prescriptionId: id, reason: body.status === "rejected" ? (body.notes || null) : null } });
        return hydrate(db, updated);
      });
    },

    /**
     * Called from orders.service#create, inside that transaction: throws if any prescription-required
     * product in the cart isn't covered by one of the customer's own approved prescriptions (decision D5 —
     * this is what closes Phase 3's known gap). Returns the prescription ids to link to the new order.
     */
    async assertCoverage(db, userId, productIds) {
      if (!productIds.length) return [];
      const covering = await repo.approvedCovering(db, userId, productIds);
      // approvedCovering already filters to prescriptions covering *some* of productIds; work out which
      // of productIds still has no approved prescription behind it.
      const itemsByRx = await repo.itemsFor(db, covering.map((r) => r.id));
      const covered = new Set();
      for (const rx of covering) for (const pid of itemsByRx.get(rx.id) ?? []) covered.add(pid);
      const missing = productIds.filter((id) => !covered.has(id));
      if (missing.length) {
        throw badRequest("PRESCRIPTION_REQUIRED", "One or more items need an approved prescription before you can order them.", missing.map((id) => ({ path: "body.items", message: `Prescription required for ${id}`, productId: id })));
      }
      return covering.map((r) => r.id);
    },

    async linkToOrder(db, orderId, prescriptionIds) {
      if (prescriptionIds.length) await repo.linkToOrder(db, orderId, prescriptionIds);
    },
  };
}
