import { toApplicationDto } from "../models/sellerApplications.model.js";
import { badRequest, conflict, forbidden, notFound } from "../utils/errors.js";
import { newStorageKey } from "./storage.service.js";
import { slugify } from "../utils/text.js";

const can = (actor, perm) => !!actor?.permissions?.includes(perm);
const OPEN_STATUSES = ["under_review", "approved", "suspended"];

/** Nested request body -> the repository's flat column shape. */
function flatten(body) {
  const isPharmacy = body.shopType === "pharmacy";
  return {
    shopName: body.shopName, shopType: body.shopType, shopContact: body.shopContact, shopEmail: body.shopEmail ?? null, shopDescription: body.shopDescription ?? null,
    addressLine: body.address.line, provinceId: body.address.provinceId, districtId: body.address.districtId, municipalityId: body.address.municipalityId,
    ward: body.address.ward, landmark: body.address.landmark ?? null, lat: body.address.lat ?? null, lng: body.address.lng ?? null,
    pharmacyLicenseNumber: isPharmacy ? body.pharmacy?.licenseNumber ?? null : null,
    pharmacyLicenseIssued: isPharmacy ? body.pharmacy?.licenseIssued ?? null : null,
    pharmacyLicenseExpires: isPharmacy ? body.pharmacy?.licenseExpires ?? null : null,
    pharmacistName: isPharmacy ? body.pharmacy?.pharmacistName ?? null : null,
    pharmacistRegNumber: isPharmacy ? body.pharmacy?.pharmacistRegNumber ?? null : null,
    operations: body.operations,
    settlementAccountHolder: body.settlement.accountHolder, settlementBankName: body.settlement.bankName ?? null,
    settlementBranch: body.settlement.branch ?? null, settlementWalletProvider: body.settlement.walletProvider ?? null,
  };
}

export function createSellerApplicationsService({ pool, withTx, repos, storage, encryption, audit, notifications = { emit: async () => null } }) {
  const repo = repos.sellerApplications;

  function assertPharmacyDetails(body) {
    if (body.shopType === "pharmacy" && !body.pharmacy) throw badRequest("PHARMACY_DETAILS_REQUIRED", "Pharmacy license and pharmacist details are required for a pharmacy shop");
  }

  /** Uploads each file's bytes to private storage and returns the row-ready records (no DB write yet). */
  async function uploadDocuments(documents) {
    const prepared = [];
    for (const doc of documents ?? []) {
      const key = newStorageKey();
      await storage.putObject(key, doc.buffer);
      prepared.push({ type: doc.type, fileKey: key, fileName: doc.fileName, mimeType: doc.mimeType, sizeBytes: doc.buffer.length });
    }
    return prepared;
  }

  async function hydrate(db, row, { reveal = false } = {}) {
    const documents = await repo.documentsFor(db, row.id);
    const settlement = {
      accountNumber: encryption.decrypt(row.settlement_account_number_enc),
      walletNumber: encryption.decrypt(row.settlement_wallet_number_enc),
    };
    return toApplicationDto(row, { documents, settlement, reveal });
  }

  async function assertReadable(actor, row) {
    if (!row) throw notFound("APPLICATION_NOT_FOUND", "Application not found");
    if (row.user_id !== actor.id && !can(actor, "sellers:read_all")) throw notFound("APPLICATION_NOT_FOUND", "Application not found");
  }

  return {
    async submit(actor, body, ctx) {
      assertPharmacyDetails(body);
      return withTx(async (db) => {
        const mine = await repo.listMine(db, actor.id);
        if (mine.some((a) => OPEN_STATUSES.includes(a.status))) throw conflict("APPLICATION_EXISTS", "You already have a shop application in progress or an active shop");
        const accountNumberEnc = encryption.encrypt(body.settlement.accountNumber);
        const walletNumberEnc = encryption.encrypt(body.settlement.walletNumber);
        const row = await repo.insert(db, { userId: actor.id, ...flatten(body), settlementAccountNumberEnc: accountNumberEnc, settlementWalletNumberEnc: walletNumberEnc });
        await repo.insertDocuments(db, row.id, await uploadDocuments(body.documents));
        await audit.log({ actor, action: "seller_application.submitted", entityType: "seller_application", entityId: row.id, newValue: { shopName: body.shopName, shopType: body.shopType } }, ctx, db);
        return hydrate(db, row, { reveal: true }); // the applicant sees their own numbers right after typing them
      });
    },

    async listMine(actor) {
      const rows = await repo.listMine(pool, actor.id);
      const docsByApp = await repo.documentsForMany(pool, rows.map((r) => r.id));
      return Promise.all(rows.map(async (r) => {
        const settlement = { accountNumber: encryption.decrypt(r.settlement_account_number_enc), walletNumber: encryption.decrypt(r.settlement_wallet_number_enc) };
        return toApplicationDto(r, { documents: docsByApp.get(r.id) ?? [], settlement, reveal: false });
      }));
    },

    async listAll(actor, { status } = {}) {
      if (!can(actor, "sellers:read_all")) throw forbidden();
      const rows = await repo.listAll(pool, { status });
      const docsByApp = await repo.documentsForMany(pool, rows.map((r) => r.id));
      return rows.map((r) => toApplicationDto(r, { documents: docsByApp.get(r.id) ?? [], settlement: { accountNumber: encryption.decrypt(r.settlement_account_number_enc), walletNumber: encryption.decrypt(r.settlement_wallet_number_enc) }, reveal: false }));
    },

    async get(actor, id) {
      const row = await repo.getById(pool, id);
      await assertReadable(actor, row);
      return hydrate(pool, row, { reveal: row.user_id === actor.id });
    },

    /** The only place a *pending* application's real bank/wallet number is decrypted for reading, beyond the
        applicant's own view — used by document/settlement review, gated the same as approving. */
    async getSettlement(actor, id) {
      if (!can(actor, "sellers:approve")) throw forbidden();
      const row = await repo.getById(pool, id);
      if (!row) throw notFound("APPLICATION_NOT_FOUND", "Application not found");
      return { accountNumber: encryption.decrypt(row.settlement_account_number_enc), walletNumber: encryption.decrypt(row.settlement_wallet_number_enc) };
    },

    async getDocumentFile(actor, applicationId, documentId) {
      const app = await repo.getById(pool, applicationId);
      await assertReadable(actor, app);
      const doc = await repo.getDocumentById(pool, documentId);
      if (!doc || doc.application_id !== applicationId) throw notFound("DOCUMENT_NOT_FOUND", "Document not found");
      const buffer = await storage.getObject(doc.file_key);
      return { buffer, mimeType: doc.mime_type, fileName: doc.file_name };
    },

    async verifyDocument(actor, applicationId, documentId, body, ctx) {
      if (!can(actor, "sellers:approve")) throw forbidden();
      return withTx(async (db) => {
        const doc = await repo.getDocumentById(db, documentId);
        if (!doc || doc.application_id !== applicationId) throw notFound("DOCUMENT_NOT_FOUND", "Document not found");
        const updated = await repo.verifyDocument(db, documentId, { verificationStatus: body.status, rejectionReason: body.status === "rejected" ? (body.reason || "Document unclear or invalid.") : null });
        await audit.log({ actor, action: `seller_application.document_${body.status}`, entityType: "seller_application", entityId: applicationId, newValue: { documentId, type: doc.type, status: body.status } }, ctx, db);
        return { id: updated.id, verificationStatus: updated.verification_status, rejectionReason: updated.rejection_reason };
      });
    },

    /**
     * approve: mints the seller (D9's `seller` role goes on the applicant's own account, additively — they
     * keep being a customer too), suspend: only once approved, both the application and its seller flip.
     * reject / request_correction both land on status "rejected" — needsCorrection is what tells the
     * applicant whether this is final or an invitation to fix and resubmit (matches the prototype exactly).
     */
    async decide(actor, id, body, ctx) {
      if (!can(actor, "sellers:approve")) throw forbidden();
      return withTx(async (db) => {
        const app = await repo.getById(db, id, { forUpdate: true });
        if (!app) throw notFound("APPLICATION_NOT_FOUND", "Application not found");

        if (body.decision === "suspend") {
          if (app.status !== "approved") throw badRequest("NOT_APPROVED", "Only an approved application's shop can be suspended");
          await repos.sellers.updateStatus(db, app.seller_id, "suspended");
          const updated = await repo.decide(db, id, { status: "suspended", decidedBy: actor.id, decidedAt: new Date() });
          await audit.log({ actor, action: "seller_application.suspended", entityType: "seller_application", entityId: id, newValue: { sellerId: app.seller_id } }, ctx, db);
          await notifications.emit(db, { userId: app.user_id, type: "seller_application.suspended", data: { applicationId: id, shopName: app.shop_name } });
          return hydrate(db, updated);
        }

        if (app.status !== "under_review") throw conflict("NOT_REVIEWABLE", `This application is already "${app.status}"`);

        if (body.decision === "approve") {
          let sellerId = slugify(app.shop_name, 60) || "shop";
          for (let n = 2; await repos.sellers.idExists(db, sellerId); n++) sellerId = `${slugify(app.shop_name, 55)}-${n}`;
          await repos.sellers.insert(db, { id: sellerId, name: app.shop_name, commissionRate: body.commissionRate ?? 12, ownerUserId: app.user_id, contactEmail: app.shop_email, contactMobile: app.shop_contact });
          await repos.roles.addUserRole(db, app.user_id, "seller", actor.id);
          const updated = await repo.decide(db, id, { status: "approved", needsCorrection: false, sellerId, rejectionReason: null, decidedBy: actor.id, decidedAt: new Date() });
          await audit.log({ actor, action: "seller_application.approved", entityType: "seller_application", entityId: id, newValue: { sellerId } }, ctx, db);
          await notifications.emit(db, { userId: app.user_id, type: "seller_application.approved", data: { applicationId: id, shopName: app.shop_name } });
          return hydrate(db, updated);
        }

        // reject / request_correction
        if (!body.reason) throw badRequest("REASON_REQUIRED", "A reason is required");
        const updated = await repo.decide(db, id, { status: "rejected", needsCorrection: body.decision === "request_correction", rejectionReason: body.reason, decidedBy: actor.id, decidedAt: new Date() });
        await audit.log({ actor, action: `seller_application.${body.decision === "request_correction" ? "correction_requested" : "rejected"}`, entityType: "seller_application", entityId: id, newValue: { reason: body.reason } }, ctx, db);
        await notifications.emit(db, { userId: app.user_id, type: body.decision === "request_correction" ? "seller_application.correction_requested" : "seller_application.rejected", data: { applicationId: id, shopName: app.shop_name, reason: body.reason } });
        return hydrate(db, updated);
      });
    },

    /** The owner fixes and tries again — every field and every document is replaced wholesale, and the
        application goes back into the review queue exactly like a first submission. */
    async resubmit(actor, id, body, ctx) {
      assertPharmacyDetails(body);
      return withTx(async (db) => {
        const app = await repo.getById(db, id, { forUpdate: true });
        if (!app) throw notFound("APPLICATION_NOT_FOUND", "Application not found");
        if (app.user_id !== actor.id) throw notFound("APPLICATION_NOT_FOUND", "Application not found");
        if (app.status !== "rejected") throw conflict("NOT_RESUBMITTABLE", "Only a rejected application can be resubmitted");

        const accountNumberEnc = encryption.encrypt(body.settlement.accountNumber);
        const walletNumberEnc = encryption.encrypt(body.settlement.walletNumber);
        await repo.replaceFields(db, id, { ...flatten(body), settlementAccountNumberEnc: accountNumberEnc, settlementWalletNumberEnc: walletNumberEnc });
        if (body.documents?.length) await repo.replaceDocuments(db, id, await uploadDocuments(body.documents));
        const updated = await repo.decide(db, id, { status: "under_review", needsCorrection: false, rejectionReason: null });
        await audit.log({ actor, action: "seller_application.resubmitted", entityType: "seller_application", entityId: id }, ctx, db);
        return hydrate(db, updated, { reveal: true });
      });
    },
  };
}
