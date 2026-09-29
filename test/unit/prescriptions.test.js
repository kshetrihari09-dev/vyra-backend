import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPrescriptionsService } from "../../src/services/prescriptions.service.js";
import { createFakePayments, rxCustomer, otherCustomer, pharmacist } from "../helpers/paymentsFakes.js";
import { fakeAudit } from "../helpers/fakes.js";

const ctx = { ip: "203.0.113.5", requestId: "r" };

function setup() {
  const fake = createFakePayments();
  const audit = fakeAudit();
  const withTx = (fn) => fn({});
  const svc = createPrescriptionsService({ pool: {}, withTx, repos: fake.repos, storage: fake.storage, audit });
  return { ...fake, audit, svc };
}

describe("prescriptions: upload and review", () => {
  it("uploads a file into private storage and defaults coverage to every Rx-required product when none is named", async () => {
    const e = setup();
    e.db._rxRequiredIds = ["cough-syrup", "antibiotic"];
    const rx = await e.svc.upload(rxCustomer, { fileName: "script.jpg", mimeType: "image/jpeg", buffer: Buffer.from("hello"), productIds: undefined }, ctx);
    assert.equal(rx.status, "pending");
    assert.deepEqual(rx.items.sort(), ["antibiotic", "cough-syrup"]);
    assert.equal((await e.storage.getObject(e.db.prescriptions[0].file_key)).toString(), "hello");
    assert.equal(e.audit.entries.at(-1).action, "prescription.uploaded");
  });

  it("a named product list is respected instead of the Rx-required default", async () => {
    const e = setup();
    e.db._rxRequiredIds = ["cough-syrup", "antibiotic"];
    const rx = await e.svc.upload(rxCustomer, { fileName: "script.jpg", mimeType: "image/jpeg", buffer: Buffer.from("x"), productIds: ["cough-syrup"] }, ctx);
    assert.deepEqual(rx.items, ["cough-syrup"]);
  });

  it("only the owner or prescriptions:read_all can see a prescription", async () => {
    const e = setup();
    const rx = await e.svc.upload(rxCustomer, { fileName: "a.jpg", mimeType: "image/jpeg", buffer: Buffer.from("x") }, ctx);
    await assert.rejects(() => e.svc.get(otherCustomer, rx.id), /not found/i);
    await assert.doesNotReject(() => e.svc.get(pharmacist, rx.id));
    await assert.doesNotReject(() => e.svc.get(rxCustomer, rx.id));
  });

  it("only prescriptions:review can decide, and a decided prescription can't be decided again", async () => {
    const e = setup();
    const rx = await e.svc.upload(rxCustomer, { fileName: "a.jpg", mimeType: "image/jpeg", buffer: Buffer.from("x"), productIds: ["cough-syrup"] }, ctx);
    await assert.rejects(() => e.svc.review(rxCustomer, rx.id, { status: "approved" }, ctx), (err) => err.status === 403);
    const approved = await e.svc.review(pharmacist, rx.id, { status: "approved", notes: "Looks valid" }, ctx);
    assert.equal(approved.status, "approved");
    assert.equal(e.audit.entries.at(-1).action, "prescription.approved");
    await assert.rejects(() => e.svc.review(pharmacist, rx.id, { status: "rejected" }, ctx), /already/i);
  });

  it("rejecting without a note still records a default reason", async () => {
    const e = setup();
    const rx = await e.svc.upload(rxCustomer, { fileName: "a.jpg", mimeType: "image/jpeg", buffer: Buffer.from("x"), productIds: ["cough-syrup"] }, ctx);
    await e.svc.review(pharmacist, rx.id, { status: "rejected" }, ctx);
    const row = await e.repos.prescriptions.getById({}, rx.id);
    assert.ok(row.rejection_reason);
  });
});

describe("prescriptions: order-eligibility gate (decision D5)", () => {
  it("no Rx-required lines means no gate at all", async () => {
    const e = setup();
    const ids = await e.svc.assertCoverage({}, rxCustomer.id, []);
    assert.deepEqual(ids, []);
  });

  it("refuses the order when nothing approved covers the line, and lists which product is missing", async () => {
    const e = setup();
    await assert.rejects(
      () => e.svc.assertCoverage({}, rxCustomer.id, ["cough-syrup"]),
      (err) => { assert.equal(err.code, "PRESCRIPTION_REQUIRED"); return true; },
    );
  });

  it("a pending (not yet reviewed) prescription does not count as coverage", async () => {
    const e = setup();
    await e.svc.upload(rxCustomer, { fileName: "a.jpg", mimeType: "image/jpeg", buffer: Buffer.from("x"), productIds: ["cough-syrup"] }, ctx);
    await assert.rejects(() => e.svc.assertCoverage({}, rxCustomer.id, ["cough-syrup"]));
  });

  it("an approved prescription covering the product lets the order through, and only that user's own is considered", async () => {
    const e = setup();
    const rx = await e.svc.upload(rxCustomer, { fileName: "a.jpg", mimeType: "image/jpeg", buffer: Buffer.from("x"), productIds: ["cough-syrup"] }, ctx);
    await e.svc.review(pharmacist, rx.id, { status: "approved" }, ctx);
    const ids = await e.svc.assertCoverage({}, rxCustomer.id, ["cough-syrup"]);
    assert.deepEqual(ids, [rx.id]);
    await assert.rejects(() => e.svc.assertCoverage({}, otherCustomer.id, ["cough-syrup"]));
  });

  it("a rejected prescription does not count, even after a fresh (approved) one is uploaded", async () => {
    const e = setup();
    const rejected = await e.svc.upload(rxCustomer, { fileName: "a.jpg", mimeType: "image/jpeg", buffer: Buffer.from("x"), productIds: ["cough-syrup"] }, ctx);
    await e.svc.review(pharmacist, rejected.id, { status: "rejected", notes: "Blurry" }, ctx);
    await assert.rejects(() => e.svc.assertCoverage({}, rxCustomer.id, ["cough-syrup"]));
    const approved = await e.svc.upload(rxCustomer, { fileName: "b.jpg", mimeType: "image/jpeg", buffer: Buffer.from("y"), productIds: ["cough-syrup"] }, ctx);
    await e.svc.review(pharmacist, approved.id, { status: "approved" }, ctx);
    assert.deepEqual(await e.svc.assertCoverage({}, rxCustomer.id, ["cough-syrup"]), [approved.id]);
  });

  it("covering two products with two separate approved prescriptions links both to the order", async () => {
    const e = setup();
    const rx1 = await e.svc.upload(rxCustomer, { fileName: "a.jpg", mimeType: "image/jpeg", buffer: Buffer.from("x"), productIds: ["cough-syrup"] }, ctx);
    const rx2 = await e.svc.upload(rxCustomer, { fileName: "b.jpg", mimeType: "image/jpeg", buffer: Buffer.from("y"), productIds: ["antibiotic"] }, ctx);
    await e.svc.review(pharmacist, rx1.id, { status: "approved" }, ctx);
    await e.svc.review(pharmacist, rx2.id, { status: "approved" }, ctx);
    const ids = await e.svc.assertCoverage({}, rxCustomer.id, ["cough-syrup", "antibiotic"]);
    assert.deepEqual(ids.sort(), [rx1.id, rx2.id].sort());
  });
});
