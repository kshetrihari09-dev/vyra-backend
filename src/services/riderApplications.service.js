import { toRiderApplicationDto } from "../models/riderApplications.model.js";
import { badRequest, conflict, forbidden, notFound } from "../utils/errors.js";
import { newStorageKey } from "./storage.service.js";

const OPEN = ["under_review", "approved"];
/** Reviewing grants the `delivery` role, so it needs the same two permissions as adding a rider directly. */
const canReview = (actor) => ["delivery:manage", "roles:assign"].every((p) => actor?.permissions?.includes(p));
const compose = (type, number) => [type, number].filter(Boolean).join(" · ");

/** A motorised rider needs a licence number + licence + vehicle registration; a bicycle courier needs an ID instead. */
function assertSubmission(body) {
  const has = (t) => body.documents.some((d) => d.type === t);
  if (body.vehicleType === "Bicycle") {
    if (!has("citizen_id")) throw badRequest("DOCUMENTS_REQUIRED", "Upload a government ID (citizenship) to apply with a bicycle.");
    return;
  }
  if (!body.licenseNumber) throw badRequest("LICENSE_REQUIRED", "Enter your driving licence number.");
  if (!has("driving_license") || !has("vehicle_registration")) throw badRequest("DOCUMENTS_REQUIRED", "Upload your driving licence and your vehicle registration (bluebook).");
}

export function createRiderApplicationsService({ pool, withTx, repos, storage, encryption, audit, provisionRider, notifications = { emit: async () => null } }) {
  const repo = repos.riderApplications;
  const notFoundApp = () => notFound("APPLICATION_NOT_FOUND", "Application not found");

  async function uploadDocuments(documents) {
    const prepared = [];
    for (const doc of documents ?? []) {
      const key = newStorageKey();
      await storage.putObject(key, doc.buffer);
      prepared.push({ type: doc.type, fileKey: key, fileName: doc.fileName, mimeType: doc.mimeType, sizeBytes: doc.buffer.length });
    }
    return prepared;
  }
  const dto = async (db, row, reveal) => toRiderApplicationDto(row, { documents: await repo.documentsFor(db, row.id), licenseNumber: encryption.decrypt(row.license_number_enc), reveal });
  /** Only the applicant and reviewers may see an application; anyone else is told it doesn't exist. */
  const assertReadable = (actor, row) => { if (!row || (row.user_id !== actor.id && !canReview(actor))) throw notFoundApp(); };

  return {
    async submit(actor, body, ctx) {
      assertSubmission(body);
      return withTx(async (db) => {
        if (await repos.delivery.getRiderByUser(db, actor.id)) throw conflict("ALREADY_RIDER", "You're already a delivery rider.");
        if ((await repo.listMine(db, actor.id)).some((a) => OPEN.includes(a.status))) throw conflict("APPLICATION_EXISTS", "You already have a rider application in progress.");
        let row;
        try {
          row = await repo.insert(db, { userId: actor.id, phone: body.phone, vehicleType: body.vehicleType, vehicleNumber: body.vehicleNumber, licenseNumberEnc: body.licenseNumber ? encryption.encrypt(body.licenseNumber) : null });
        } catch (err) {
          if (err.code === "23505") throw conflict("APPLICATION_EXISTS", "You already have a rider application in progress."); // a double-submit race: the partial unique index caught it
          throw err;
        }
        await repo.insertDocuments(db, row.id, await uploadDocuments(body.documents));
        await audit.log({ actor, action: "rider_application.submitted", entityType: "rider_application", entityId: row.id, newValue: { vehicleType: body.vehicleType } }, ctx, db);
        return dto(db, row, true);
      });
    },

    async listMine(actor) {
      const rows = await repo.listMine(pool, actor.id);
      return Promise.all(rows.map((r) => dto(pool, r, true)));
    },

    async listAll(actor, { status } = {}) {
      if (!canReview(actor)) throw forbidden();
      const rows = await repo.listAll(pool, { status });
      const docs = await repo.documentsForMany(pool, rows.map((r) => r.id));
      return rows.map((r) => toRiderApplicationDto(r, { documents: docs.get(r.id) ?? [], licenseNumber: encryption.decrypt(r.license_number_enc), reveal: false }));
    },

    async get(actor, id) {
      const row = await repo.getById(pool, id);
      assertReadable(actor, row);
      return dto(pool, row, true); // the applicant's own number, or a reviewer checking it against the documents
    },

    async getDocumentFile(actor, applicationId, documentId) {
      const app = await repo.getById(pool, applicationId);
      assertReadable(actor, app);
      const doc = await repo.getDocumentById(pool, documentId);
      if (!doc || doc.application_id !== applicationId) throw notFound("DOCUMENT_NOT_FOUND", "Document not found");
      return { buffer: await storage.getObject(doc.file_key), mimeType: doc.mime_type, fileName: doc.file_name };
    },

    /**
     * approve → the applicant becomes a rider through the SAME provisioning an admin uses (delivery role + profile);
     * reject → final; request_correction → the applicant may fix and resubmit.
     * Lock order: user → application → rider, matching the rest of the delivery module.
     */
    async decide(actor, id, body, ctx) {
      if (!canReview(actor)) throw forbidden();
      return withTx(async (db) => {
        const peek = await repo.getById(db, id);
        if (!peek) throw notFoundApp();
        if (body.decision === "approve") await repos.users.lockById(db, peek.user_id);   // 1. user
        const app = await repo.getById(db, id, { forUpdate: true });                      // 2. application
        if (app.status !== "under_review") throw conflict("NOT_REVIEWABLE", `This application is already "${app.status}".`);

        if (body.decision === "approve") {
          const rider = await provisionRider(db, { actor, userId: app.user_id, phone: app.phone, vehicle: compose(app.vehicle_type, app.vehicle_number), via: "application" }, ctx); // 3. rider
          const updated = await repo.decide(db, id, { status: "approved", riderId: rider.id, decidedBy: actor.id, decidedAt: new Date() });
          await audit.log({ actor, action: "rider_application.approved", entityType: "rider_application", entityId: id, newValue: { riderId: rider.id } }, ctx, db);
          await notifications.emit(db, { userId: app.user_id, type: "rider_application.approved", data: { applicationId: id } });
          return dto(db, updated, true);
        }

        if (!body.reason) throw badRequest("REASON_REQUIRED", "A reason is required");
        const correction = body.decision === "request_correction";
        const updated = await repo.decide(db, id, { status: "rejected", needsCorrection: correction, rejectionReason: body.reason, decidedBy: actor.id, decidedAt: new Date() });
        await audit.log({ actor, action: `rider_application.${correction ? "correction_requested" : "rejected"}`, entityType: "rider_application", entityId: id, newValue: { reason: body.reason } }, ctx, db);
        await notifications.emit(db, { userId: app.user_id, type: correction ? "rider_application.correction_requested" : "rider_application.rejected", data: { applicationId: id, reason: body.reason } });
        return dto(db, updated, true);
      });
    },

    /** Only the applicant, and only when a reviewer asked for changes. Fields and documents are replaced wholesale. */
    async resubmit(actor, id, body, ctx) {
      assertSubmission(body);
      return withTx(async (db) => {
        const app = await repo.getById(db, id, { forUpdate: true });
        if (!app || app.user_id !== actor.id) throw notFoundApp();
        if (app.status !== "rejected" || !app.needs_correction) throw conflict("NOT_RESUBMITTABLE", "Only an application where changes were requested can be resubmitted.");
        await repo.replaceFields(db, id, { phone: body.phone, vehicleType: body.vehicleType, vehicleNumber: body.vehicleNumber, licenseNumberEnc: body.licenseNumber ? encryption.encrypt(body.licenseNumber) : null });
        await repo.replaceDocuments(db, id, await uploadDocuments(body.documents));
        const updated = await repo.decide(db, id, { status: "under_review", needsCorrection: false, rejectionReason: null });
        await audit.log({ actor, action: "rider_application.resubmitted", entityType: "rider_application", entityId: id }, ctx, db);
        return dto(db, updated, true);
      });
    },
  };
}
