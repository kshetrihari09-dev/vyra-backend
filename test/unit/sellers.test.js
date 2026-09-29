import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSellersService } from "../../src/services/sellers.service.js";
import { createSellerPayoutsService } from "../../src/services/sellerPayouts.service.js";
import { createSellerApplicationsService } from "../../src/services/sellerApplications.service.js";
import { accountant, adminActor, applicant, baseApplicationBody, createFakeSellers } from "../helpers/sellersFakes.js";
import { fakeAudit } from "../helpers/fakes.js";

const ctx = { ip: "203.0.113.5", requestId: "r" };
const sellerOwner = { id: "u-seller-owner", name: "Owner", roles: ["seller"], permissions: ["seller:manage_own"], sellerId: "acme-pharmacy" };

function setup(orderItems) {
  const fake = createFakeSellers({ orderItems });
  const audit = fakeAudit();
  const withTx = (fn) => fn({});
  const sellers = createSellersService({ pool: {}, withTx, repos: fake.repos, encryption: fake.encryption, audit });
  const payouts = createSellerPayoutsService({ pool: {}, withTx, repos: fake.repos, audit });
  const applications = createSellerApplicationsService({ pool: {}, withTx, repos: fake.repos, storage: fake.storage, encryption: fake.encryption, audit });
  return { ...fake, audit, sellers, payouts, applications };
}

async function approvedSeller(e) {
  const app = await e.applications.submit(applicant, baseApplicationBody(), ctx);
  const decided = await e.applications.decide(adminActor, app.id, { decision: "approve" }, ctx);
  return decided.sellerId;
}

describe("sellers: directory and status", () => {
  it("only sellers:read_all can list; get() is owner-or-staff, 404 for anyone else", async () => {
    const e = setup();
    const sellerId = await approvedSeller(e);
    await assert.rejects(e.sellers.list({ permissions: [] }), (err) => err.status === 403);
    assert.equal((await e.sellers.list(adminActor)).sellers.length, 1);
    await assert.rejects(e.sellers.get({ id: "stranger", permissions: [], sellerId: null }, sellerId), (err) => err.status === 404);
    assert.equal((await e.sellers.get({ id: "owner", permissions: [], sellerId }, sellerId)).id, sellerId);
  });

  it("getMine returns null with no seller, and the owner's shop otherwise", async () => {
    const e = setup();
    assert.equal(await e.sellers.getMine({ sellerId: null }), null);
    const sellerId = await approvedSeller(e);
    assert.equal((await e.sellers.getMine({ sellerId, permissions: [] })).id, sellerId);
  });

  it("only sellers:approve can suspend/reinstate, and the first-party seller can never be suspended", async () => {
    const e = setup();
    const sellerId = await approvedSeller(e);
    await assert.rejects(e.sellers.setStatus({ permissions: [] }, sellerId, "suspended", ctx), (err) => err.status === 403);
    const suspended = await e.sellers.setStatus(adminActor, sellerId, "suspended", ctx);
    assert.equal(suspended.status, "suspended");
    e.db.sellers[0].first_party = true;
    await assert.rejects(e.sellers.setStatus(adminActor, sellerId, "suspended", ctx), (err) => err.code === "FIRST_PARTY_LOCKED");
  });
});

describe("sellers: settlement reveal", () => {
  it("is gated to payouts:approve/sellers:approve, and returns the real number from the approved application", async () => {
    const e = setup();
    const sellerId = await approvedSeller(e);
    await assert.rejects(e.sellers.getSettlement({ permissions: [] }, sellerId), (err) => err.status === 403);
    const revealed = await e.sellers.getSettlement(adminActor, sellerId);
    assert.equal(revealed.accountNumber, "0011223344");
  });
});

describe("payouts: decision D3 — delivered orders, net of commission, minus what's already requested", () => {
  it("computes the available balance correctly and defaults a request to it", async () => {
    const e = setup([
      { seller_id: "acme-pharmacy", line_total: 1000, order_status: "delivered" },
      { seller_id: "acme-pharmacy", line_total: 500, order_status: "confirmed" }, // not delivered — excluded
      { seller_id: "other-seller", line_total: 999, order_status: "delivered" }, // different seller — excluded
    ]);
    const sellerId = await approvedSeller(e); // "acme-pharmacy" per baseApplicationBody's shop name slug
    assert.equal(sellerId, "acme-pharmacy");
    const available = await e.sellers.availableBalance(sellerOwner, sellerId); // commission 12% by default
    assert.equal(available, 880); // 1000 * 0.88

    const payout = await e.payouts.request(sellerOwner, sellerId, {}, ctx);
    assert.equal(payout.amount, 880);
    assert.equal(payout.status, "requested");
  });

  it("a second request is capped at what's left after the first is already pending", async () => {
    const e = setup([{ seller_id: "acme-pharmacy", line_total: 1000, order_status: "delivered" }]);
    const sellerId = await approvedSeller(e);
    await e.payouts.request(sellerOwner, sellerId, { amount: 500 }, ctx);
    await assert.rejects(e.payouts.request(sellerOwner, sellerId, { amount: 500 }, ctx), (err) => err.code === "EXCEEDS_AVAILABLE");
    const rest = await e.payouts.request(sellerOwner, sellerId, {}, ctx);
    assert.equal(rest.amount, 380); // 880 - 500
  });

  it("only the seller themself can request, and only for an active shop", async () => {
    const e = setup([{ seller_id: "acme-pharmacy", line_total: 1000, order_status: "delivered" }]);
    const sellerId = await approvedSeller(e);
    await assert.rejects(e.payouts.request({ sellerId: "someone-else" }, sellerId, {}, ctx), (err) => err.status === 403);
    await e.sellers.setStatus(adminActor, sellerId, "suspended", ctx);
    await assert.rejects(e.payouts.request(sellerOwner, sellerId, {}, ctx), (err) => err.code === "SELLER_NOT_ACTIVE");
  });

  it("refuses a request when nothing is available", async () => {
    const e = setup([]);
    const sellerId = await approvedSeller(e);
    await assert.rejects(e.payouts.request(sellerOwner, sellerId, {}, ctx), (err) => err.code === "NOTHING_AVAILABLE");
  });
});

describe("payouts: decide", () => {
  it("only payouts:approve decides, and not twice; approving marks it paid immediately", async () => {
    const e = setup([{ seller_id: "acme-pharmacy", line_total: 1000, order_status: "delivered" }]);
    const sellerId = await approvedSeller(e);
    const payout = await e.payouts.request(sellerOwner, sellerId, {}, ctx);
    await assert.rejects(e.payouts.decide(sellerOwner, payout.id, { decision: "approve" }, ctx), (err) => err.status === 403);
    const decided = await e.payouts.decide(accountant, payout.id, { decision: "approve" }, ctx);
    assert.equal(decided.status, "paid");
    assert.ok(decided.paidAt);
    await assert.rejects(e.payouts.decide(accountant, payout.id, { decision: "reject" }, ctx), (err) => err.code === "ALREADY_DECIDED");
  });

  it("rejecting frees the amount back up for a future request", async () => {
    const e = setup([{ seller_id: "acme-pharmacy", line_total: 1000, order_status: "delivered" }]);
    const sellerId = await approvedSeller(e);
    const payout = await e.payouts.request(sellerOwner, sellerId, {}, ctx);
    await e.payouts.decide(accountant, payout.id, { decision: "reject", note: "Bank details need updating" }, ctx);
    const available = await e.sellers.availableBalance(sellerOwner, sellerId);
    assert.equal(available, 880); // the rejected payout's amount no longer counts as "already requested"
  });
});
