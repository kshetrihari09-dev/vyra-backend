import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { boot, loginAs, makeUser, skipReason } from "./helpers.js";

const FILE = (name = "scan.png") => ({ fileName: name, mimeType: "image/png", dataBase64: `data:image/png;base64,${Buffer.from("not-really-a-png-but-bytes").toString("base64")}` });
const MOTOR = (over = {}) => ({
  phone: "9801234567", vehicleType: "Bike", vehicleNumber: "BA 12 PA 1234", licenseNumber: "01-06-00123456",
  documents: [{ type: "driving_license", ...FILE("licence.png") }, { type: "vehicle_registration", ...FILE("bluebook.png") }], ...over,
});

describe("rider applications (real Postgres)", { skip: skipReason }, () => {
  let ctx, admin, warehouse;
  const auth = (t) => ({ Authorization: `Bearer ${t}` });
  const login = async (u) => auth((await loginAs(ctx.request, u)).token);
  const q = (sql, p) => ctx.container.pool.query(sql, p);
  async function applicant(over) {
    const user = await makeUser(ctx.container);
    const token = await login(user);
    const res = await ctx.request.post("/api/rider-applications").set(token).send(MOTOR(over));
    return { user, token, res, id: res.body?.data?.application?.id };
  }
  const decide = (id, body, who = admin) => ctx.request.post(`/api/rider-applications/${id}/decide`).set(who).send(body);

  before(async () => {
    ctx = await boot();
    admin = await login(await makeUser(ctx.container, { roles: ["admin"] }));
    warehouse = await login(await makeUser(ctx.container, { roles: ["warehouse"] })); // delivery:manage but NOT roles:assign
  });
  after(async () => { await ctx?.close(); });

  it("a signed-in user applies; the response never carries storage keys, and the licence number is theirs to see", async () => {
    const a = await applicant();
    assert.equal(a.res.status, 201, JSON.stringify(a.res.body));
    const app = a.res.body.data.application;
    assert.equal(app.status, "under_review");
    assert.equal(app.licenseNumber, "01-06-00123456");
    assert.equal(app.documents.length, 2);
    assert.ok(!/file_key|fileKey/.test(JSON.stringify(a.res.body)));
    const stored = (await q("SELECT license_number_enc FROM rider_applications WHERE id = $1", [a.id])).rows[0].license_number_enc;
    assert.ok(stored && !stored.includes("01-06-00123456"), "licence number is encrypted at rest");
  });

  it("requires the right documents for the vehicle", async () => {
    const user = await makeUser(ctx.container); const t = await login(user);
    const noReg = await ctx.request.post("/api/rider-applications").set(t).send(MOTOR({ documents: [{ type: "driving_license", ...FILE() }] }));
    assert.equal(noReg.status, 400); assert.equal(noReg.body.code, "DOCUMENTS_REQUIRED");
    const noLicence = await ctx.request.post("/api/rider-applications").set(t).send(MOTOR({ licenseNumber: undefined }));
    assert.equal(noLicence.body.code, "LICENSE_REQUIRED");
    const bicycleNoId = await ctx.request.post("/api/rider-applications").set(t).send({ phone: "9801234567", vehicleType: "Bicycle", documents: [{ type: "other", ...FILE() }] });
    assert.equal(bicycleNoId.body.code, "DOCUMENTS_REQUIRED");
    const bicycle = await ctx.request.post("/api/rider-applications").set(t).send({ phone: "9801234567", vehicleType: "Bicycle", documents: [{ type: "citizen_id", ...FILE() }] });
    assert.equal(bicycle.status, 201, JSON.stringify(bicycle.body));
  });

  it("rejects a bad file type and anything claiming to be someone else", async () => {
    const t = await login(await makeUser(ctx.container));
    const exe = await ctx.request.post("/api/rider-applications").set(t).send(MOTOR({ documents: [{ type: "driving_license", fileName: "x.exe", mimeType: "application/x-msdownload", dataBase64: "AAAA" }] }));
    assert.equal(exe.status, 400);
    const other = await makeUser(ctx.container);
    const forged = await ctx.request.post("/api/rider-applications").set(t).send({ ...MOTOR(), userId: other.id });
    assert.equal(forged.status, 400, "no userId is accepted: the applicant is always the signed-in account");
  });

  it("one open application per user, even when submitted twice at the same instant", async () => {
    const user = await makeUser(ctx.container); const t = await login(user);
    const res = await Promise.all([1, 2, 3].map(() => ctx.request.post("/api/rider-applications").set(t).send(MOTOR())));
    assert.deepEqual(res.map((r) => r.status).sort(), [201, 409, 409]);
    assert.ok(res.filter((r) => r.status === 409).every((r) => r.body.code === "APPLICATION_EXISTS"));
    assert.equal(Number((await q("SELECT count(*) n FROM rider_applications WHERE user_id = $1", [user.id])).rows[0].n), 1);
  });

  it("only the applicant and full reviewers can read an application or its documents", async () => {
    const a = await applicant(); const stranger = await login(await makeUser(ctx.container));
    const docId = a.res.body.data.application.documents[0].id;
    assert.equal((await ctx.request.get(`/api/rider-applications/${a.id}`).set(stranger)).status, 404);
    assert.equal((await ctx.request.get(`/api/rider-applications/${a.id}/documents/${docId}/file`).set(stranger)).status, 404);
    assert.equal((await ctx.request.get(`/api/rider-applications/${a.id}`).set(warehouse)).status, 404, "dispatch alone can't read ID documents");
    assert.equal((await ctx.request.get("/api/rider-applications?scope=all").set(stranger)).status, 403);
    assert.equal((await ctx.request.get("/api/rider-applications?scope=all").set(warehouse)).status, 403);
    const file = await ctx.request.get(`/api/rider-applications/${a.id}/documents/${docId}/file`).set(admin);
    assert.equal(file.status, 200); assert.equal(file.headers["cache-control"], "private, max-age=0, no-store");
    assert.equal((await ctx.request.get(`/api/rider-applications/${a.id}/documents/${docId}/file`).set(a.token)).status, 200);
    const list = await ctx.request.get("/api/rider-applications?scope=all&status=under_review").set(admin);
    assert.equal(list.status, 200);
    const row = list.body.data.applications.find((x) => x.id === a.id);
    assert.match(row.licenseNumber, /^•••• /, "the list view masks the licence number");
  });

  it("approving makes them a rider through the normal path: role, profile, immediate access, notification", async () => {
    const a = await applicant();
    assert.equal((await ctx.request.get("/api/rider/me").set(a.token)).status, 403, "not a rider yet");
    assert.equal((await decide(a.id, { decision: "approve" }, warehouse)).status, 403, "needs roles:assign as well");
    const res = await decide(a.id, { decision: "approve" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.application.status, "approved");
    const rider = await ctx.request.get("/api/rider/me").set(a.token); // same token: access is read live, no re-login needed
    assert.equal(rider.status, 200, JSON.stringify(rider.body));
    assert.equal(rider.body.data.rider.vehicleType, "Bike"); assert.equal(rider.body.data.rider.vehicleNumber, "BA 12 PA 1234");
    assert.equal(rider.body.data.rider.isAvailable, false, "starts off duty");
    assert.equal(Number((await q("SELECT count(*) n FROM user_roles WHERE user_id = $1 AND role_key = 'delivery'", [a.user.id])).rows[0].n), 1);
    assert.ok(Number((await q("SELECT count(*) n FROM notifications WHERE user_id = $1 AND type = 'rider_application.approved'", [a.user.id])).rows[0].n) >= 1);
    assert.equal((await decide(a.id, { decision: "approve" })).status, 409, "can't approve twice");
    assert.equal((await ctx.request.post("/api/rider-applications").set(a.token).send(MOTOR())).body.code, "ALREADY_RIDER");
  });

  it("two reviewers approving at once create exactly one rider", async () => {
    const a = await applicant();
    const res = await Promise.all([decide(a.id, { decision: "approve" }), decide(a.id, { decision: "approve" }), decide(a.id, { decision: "approve" })]);
    assert.deepEqual(res.map((r) => r.status).sort(), [200, 409, 409], JSON.stringify(res.map((r) => r.body)));
    assert.equal(Number((await q("SELECT count(*) n FROM riders WHERE user_id = $1", [a.user.id])).rows[0].n), 1);
  });

  it("an applicant who was suspended meanwhile can't be approved", async () => {
    const a = await applicant();
    await q("UPDATE users SET status = 'suspended' WHERE id = $1", [a.user.id]);
    const res = await decide(a.id, { decision: "approve" });
    assert.equal(res.status, 409); assert.equal(res.body.code, "USER_INACTIVE");
    assert.equal((await q("SELECT status FROM rider_applications WHERE id = $1", [a.id])).rows[0].status, "under_review", "application untouched");
  });

  it("reject needs a reason and is final; request_correction lets the applicant fix and resubmit", async () => {
    const a = await applicant();
    assert.equal((await decide(a.id, { decision: "reject" })).body.code, "REASON_REQUIRED");
    const fix = await decide(a.id, { decision: "request_correction", reason: "Licence photo is blurry" });
    assert.equal(fix.body.data.application.needsCorrection, true);
    const mine = await ctx.request.get("/api/rider-applications").set(a.token);
    assert.equal(mine.body.data.applications[0].rejectionReason, "Licence photo is blurry");
    const again = await ctx.request.post(`/api/rider-applications/${a.id}/resubmit`).set(a.token).send(MOTOR({ vehicleNumber: "BA 99 PA 0001" }));
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.data.application.status, "under_review"); assert.equal(again.body.data.application.vehicleNumber, "BA 99 PA 0001");
    assert.equal((await ctx.request.post(`/api/rider-applications/${a.id}/resubmit`).set(a.token).send(MOTOR())).status, 409, "only after changes were requested");
    assert.equal((await decide(a.id, { decision: "reject", reason: "Documents don't match" })).body.data.application.needsCorrection, false);
    assert.equal((await ctx.request.post(`/api/rider-applications/${a.id}/resubmit`).set(a.token).send(MOTOR())).status, 409, "a final rejection can't be resubmitted");
    const fresh = await ctx.request.post("/api/rider-applications").set(a.token).send(MOTOR());
    assert.equal(fresh.status, 201, "…but they may start a new application");
    const stranger = await login(await makeUser(ctx.container));
    assert.equal((await ctx.request.post(`/api/rider-applications/${a.id}/resubmit`).set(stranger).send(MOTOR())).status, 404);
  });
});
