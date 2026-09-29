import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSellerApplicationsService } from "../../src/services/sellerApplications.service.js";
import { adminActor, applicant, baseApplicationBody, createFakeSellers, otherApplicant } from "../helpers/sellersFakes.js";
import { fakeAudit } from "../helpers/fakes.js";

const ctx = { ip: "203.0.113.5", requestId: "r" };

function setup() {
  const fake = createFakeSellers();
  const audit = fakeAudit();
  const withTx = (fn) => fn({});
  const svc = createSellerApplicationsService({ pool: {}, withTx, repos: fake.repos, storage: fake.storage, encryption: fake.encryption, audit });
  return { ...fake, audit, svc };
}

describe("seller applications: submit", () => {
  it("stores the application, encrypts the settlement number, uploads documents, and shows the applicant their own number back", async () => {
    const e = setup();
    const app = await e.svc.submit(applicant, baseApplicationBody(), ctx);
    assert.equal(app.status, "under_review");
    assert.equal(app.shopName, "Acme Pharmacy");
    assert.equal(app.settlement.accountNumber, "0011223344"); // reveal:true for the applicant's own submission
    assert.equal(app.documents.length, 1);
    assert.equal(app.documents[0].verificationStatus, "pending");
    // the raw DB row never holds plaintext
    assert.notEqual(e.db.applications[0].settlement_account_number_enc?.toString("utf8"), "0011223344");
    assert.equal(e.audit.entries.at(-1).action, "seller_application.submitted");
  });

  it("requires pharmacy license details when shopType is pharmacy", async () => {
    const e = setup();
    await assert.rejects(e.svc.submit(applicant, baseApplicationBody({ pharmacy: undefined }), ctx));
  });

  it("refuses a second application while one is under review, approved, or suspended", async () => {
    const e = setup();
    await e.svc.submit(applicant, baseApplicationBody(), ctx);
    await assert.rejects(e.svc.submit(applicant, baseApplicationBody(), ctx), (err) => err.code === "APPLICATION_EXISTS");
  });
});

describe("seller applications: reading", () => {
  it("a customer only ever sees their own masked number; sellers:read_all sees every application, also masked", async () => {
    const e = setup();
    await e.svc.submit(applicant, baseApplicationBody(), ctx);
    const mine = await e.svc.listMine(applicant);
    assert.equal(mine.length, 1);
    assert.match(mine[0].settlement.accountNumber, /^•+/);
    const all = await e.svc.listAll(adminActor);
    assert.equal(all.length, 1);
    assert.match(all[0].settlement.accountNumber, /^•+/);
    await assert.rejects(e.svc.listAll(applicant), (err) => err.status === 403);
  });

  it("a stranger gets 404 on someone else's application, not 403", async () => {
    const e = setup();
    const app = await e.svc.submit(applicant, baseApplicationBody(), ctx);
    await assert.rejects(e.svc.get(otherApplicant, app.id), (err) => err.status === 404);
    await assert.doesNotReject(e.svc.get(adminActor, app.id));
  });

  it("getSettlement reveals the real number only to sellers:approve/payouts:approve", async () => {
    const e = setup();
    const app = await e.svc.submit(applicant, baseApplicationBody(), ctx);
    await assert.rejects(e.svc.getSettlement(applicant, app.id), (err) => err.status === 403);
    const revealed = await e.svc.getSettlement(adminActor, app.id);
    assert.equal(revealed.accountNumber, "0011223344");
  });
});

describe("seller applications: document verification", () => {
  it("only sellers:approve can verify a document, and it's scoped to the right application", async () => {
    const e = setup();
    const app = await e.svc.submit(applicant, baseApplicationBody(), ctx);
    const docId = app.documents[0].id;
    await assert.rejects(e.svc.verifyDocument(applicant, app.id, docId, { status: "verified" }, ctx), (err) => err.status === 403);
    const result = await e.svc.verifyDocument(adminActor, app.id, docId, { status: "rejected", reason: "Blurry photo" }, ctx);
    assert.equal(result.verificationStatus, "rejected");
    assert.equal(result.rejectionReason, "Blurry photo");
  });
});

describe("seller applications: decide (approve/reject/request_correction/suspend)", () => {
  it("only sellers:approve decides, and not twice", async () => {
    const e = setup();
    const app = await e.svc.submit(applicant, baseApplicationBody(), ctx);
    await assert.rejects(e.svc.decide(applicant, app.id, { decision: "approve" }, ctx), (err) => err.status === 403);
    await e.svc.decide(adminActor, app.id, { decision: "approve" }, ctx);
    await assert.rejects(e.svc.decide(adminActor, app.id, { decision: "reject", reason: "x" }, ctx), (err) => err.code === "NOT_REVIEWABLE");
  });

  it("approving mints an active seller, grants the seller role, links sellerId, and defaults commission to 12", async () => {
    const e = setup();
    const app = await e.svc.submit(applicant, baseApplicationBody({ shopName: "Acme Pharmacy!!" }), ctx);
    const decided = await e.svc.decide(adminActor, app.id, { decision: "approve" }, ctx);
    assert.equal(decided.status, "approved");
    assert.ok(decided.sellerId);
    const seller = e.db.sellers.find((s) => s.id === decided.sellerId);
    assert.equal(seller.status, "active");
    assert.equal(Number(seller.commission_rate), 12);
    assert.equal(seller.owner_user_id, applicant.id);
    assert.ok(e.db.userRoles.some((r) => r.userId === applicant.id && r.roleKey === "seller"));
  });

  it("an admin can set a custom commission rate at approval time", async () => {
    const e = setup();
    const app = await e.svc.submit(applicant, baseApplicationBody(), ctx);
    const decided = await e.svc.decide(adminActor, app.id, { decision: "approve", commissionRate: 8 }, ctx);
    const seller = e.db.sellers.find((s) => s.id === decided.sellerId);
    assert.equal(Number(seller.commission_rate), 8);
  });

  it("reject and request_correction both land on status rejected, differing only in needsCorrection", async () => {
    const e = setup();
    const app1 = await e.svc.submit(applicant, baseApplicationBody(), ctx);
    const rejected = await e.svc.decide(adminActor, app1.id, { decision: "reject", reason: "Invalid documents" }, ctx);
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.needsCorrection, false);

    const app2 = await e.svc.submit(otherApplicant, baseApplicationBody({ shopName: "Other Shop" }), ctx);
    const corrected = await e.svc.decide(adminActor, app2.id, { decision: "request_correction", reason: "Fuzzy license photo" }, ctx);
    assert.equal(corrected.status, "rejected");
    assert.equal(corrected.needsCorrection, true);
  });

  it("a reason is required to reject or request correction", async () => {
    const e = setup();
    const app = await e.svc.submit(applicant, baseApplicationBody(), ctx);
    await assert.rejects(e.svc.decide(adminActor, app.id, { decision: "reject" }, ctx), (err) => err.code === "REASON_REQUIRED");
  });

  it("suspend only applies to an approved application, and flips both the seller and the application", async () => {
    const e = setup();
    const app = await e.svc.submit(applicant, baseApplicationBody(), ctx);
    await assert.rejects(e.svc.decide(adminActor, app.id, { decision: "suspend" }, ctx), (err) => err.code === "NOT_APPROVED");
    const approved = await e.svc.decide(adminActor, app.id, { decision: "approve" }, ctx);
    const suspended = await e.svc.decide(adminActor, app.id, { decision: "suspend" }, ctx);
    assert.equal(suspended.status, "suspended");
    assert.equal(e.db.sellers.find((s) => s.id === approved.sellerId).status, "suspended");
  });
});

describe("seller applications: resubmit", () => {
  it("only the owner can resubmit, only when rejected, and it goes back to under_review with needsCorrection cleared", async () => {
    const e = setup();
    const app = await e.svc.submit(applicant, baseApplicationBody(), ctx);
    await assert.rejects(e.svc.resubmit(applicant, app.id, baseApplicationBody(), ctx), (err) => err.code === "NOT_RESUBMITTABLE");
    await e.svc.decide(adminActor, app.id, { decision: "request_correction", reason: "Fix the license photo" }, ctx);
    await assert.rejects(e.svc.resubmit(otherApplicant, app.id, baseApplicationBody(), ctx), (err) => err.status === 404);
    const resubmitted = await e.svc.resubmit(applicant, app.id, baseApplicationBody({ shopDescription: "Updated description" }), ctx);
    assert.equal(resubmitted.status, "under_review");
    assert.equal(resubmitted.needsCorrection, false);
    assert.equal(resubmitted.shopDescription, "Updated description");
  });
});
