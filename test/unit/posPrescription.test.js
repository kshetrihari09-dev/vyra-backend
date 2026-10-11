import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateInStore, validateOnline } from "../../src/domain/posPrescription.js";
import { RX_MAX_AGE_DAYS } from "../../src/config/pos.js";

const NOW = new Date("2026-06-15T10:00:00Z");
const ok = (over = {}) => ({ patientName: "Sita Rai", prescriberName: "Dr. A. Sharma", prescriberRegNo: "NMC-1234", issuedOn: "2026-06-10", verified: true, ...over });
const code = (c) => (err) => err.code === c;

describe("in-store prescription", () => {
  it("accepts a complete, recent prescription and normalises it", () => {
    const r = validateInStore(ok({ patientName: "  Sita   Rai ", notes: "  take after food  " }), NOW);
    assert.deepEqual([r.patientName, r.prescriberName, r.prescriberRegNo, r.issuedOn, r.notes], ["Sita Rai", "Dr. A. Sharma", "NMC-1234", "2026-06-10", "take after food"]);
  });
  it("the registration number is optional", () => assert.equal(validateInStore(ok({ prescriberRegNo: "" }), NOW).prescriberRegNo, null));
  it("requires patient, prescriber and the pharmacist's confirmation", () => {
    assert.throws(() => validateInStore(ok({ patientName: "  " }), NOW), code("PRESCRIPTION_INVALID"));
    assert.throws(() => validateInStore(ok({ prescriberName: "" }), NOW), code("PRESCRIPTION_INVALID"));
    for (const verified of [false, undefined, "true", 1, null]) assert.throws(() => validateInStore(ok({ verified }), NOW), /checked the original/, String(verified));
  });
  it("rejects missing, malformed and impossible dates", () => {
    for (const issuedOn of [undefined, "", "yesterday", "2026-6-1", "2026-02-30", "2026-13-01", "15/06/2026", "2026-06-10T00:00:00Z"]) assert.throws(() => validateInStore(ok({ issuedOn }), NOW), code("PRESCRIPTION_INVALID"), String(issuedOn));
  });
  it("rejects a future date (one day of timezone slack) and an expired one", () => {
    assert.doesNotThrow(() => validateInStore(ok({ issuedOn: "2026-06-16" }), NOW));
    assert.throws(() => validateInStore(ok({ issuedOn: "2026-06-17" }), NOW), /in the future/);
    assert.doesNotThrow(() => validateInStore(ok({ issuedOn: new Date(NOW.getTime() - RX_MAX_AGE_DAYS * 86_400_000).toISOString().slice(0, 10) }), NOW));
    assert.throws(() => validateInStore(ok({ issuedOn: new Date(NOW.getTime() - (RX_MAX_AGE_DAYS + 2) * 86_400_000).toISOString().slice(0, 10) }), NOW), code("PRESCRIPTION_EXPIRED"));
  });
  it("clips over-long text instead of storing unbounded input", () => assert.equal(validateInStore(ok({ patientName: "x".repeat(500) }), NOW).patientName.length, 100));
});

describe("online prescription", () => {
  const REQ = [{ productId: "amox", name: "Amoxicillin 500" }, { productId: "cef", name: "Cefixime" }];
  const rx = (over = {}) => ({ status: "approved", reviewed_at: "2026-06-01T00:00:00Z", ...over });
  it("must exist, be approved, and cover EVERY prescription-required medicine sold", () => {
    assert.doesNotThrow(() => validateOnline(rx(), ["amox", "cef", "extra"], REQ, NOW));
    assert.throws(() => validateOnline(null, [], REQ, NOW), /could not be found/);
    for (const status of ["pending", "rejected"]) assert.throws(() => validateOnline(rx({ status }), ["amox", "cef"], REQ, NOW), /not been approved/);
    assert.throws(() => validateOnline(rx(), ["amox"], REQ, NOW), (e) => e.code === "PRESCRIPTION_INVALID" && /Cefixime/.test(e.message) && !/Amoxicillin/.test(e.message));
  });
  it("an approval older than the limit is expired", () => assert.throws(() => validateOnline(rx({ reviewed_at: "2025-01-01T00:00:00Z" }), ["amox", "cef"], REQ, NOW), code("PRESCRIPTION_EXPIRED")));
});
