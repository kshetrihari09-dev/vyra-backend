import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGeoService } from "../../src/services/geo.service.js";
import { locateQuery } from "../../src/validators/geo.validators.js";

/** Runs against the real boundary file (the data IS what's under test). */
const geo = createGeoService();
const at = async (lat, lng) => geo.locate(lat, lng);

describe("pin -> province / district / municipality (real boundaries)", () => {
  const cases = [
    ["Kathmandu Durbar Square", 27.7044, 85.3157, "bagmati", "kathmandu", "ktm-metro", 32],
    ["Butwal", 27.7006, 83.4483, "lumbini", "rupandehi", "butwal-sub", 19],
    ["Siddharthanagar", 27.5, 83.45, "lumbini", "rupandehi", "siddharthanagar", 13],
    ["Pokhara", 28.2096, 83.9856, "gandaki", "kaski", "pokhara-metro", 33],
    ["Biratnagar", 26.4525, 87.2718, "koshi", "morang", "biratnagar-metro", 19],
    ["Janakpur", 26.7288, 85.9266, "madhesh", "dhanusha", "janakpur-sub", 25],
    ["Birgunj", 27.0104, 84.877, "madhesh", "parsa", "birgunj-metro", 32],
    ["Lalitpur", 27.6588, 85.3247, "bagmati", "lalitpur", "lalitpur-metro", 29],
  ];
  for (const [name, lat, lng, province, district, muni, wards] of cases) {
    it(`${name}`, async () => {
      const r = await at(lat, lng);
      assert.equal(r.inNepal, true); assert.equal(r.province.id, province); assert.equal(r.district.id, district);
      assert.equal(r.municipality.id, muni); assert.equal(r.municipality.wards, wards);
      assert.equal(r.approximate, false);
    });
  }
  it("returns display names that match the address form's wording", async () => {
    const r = await at(27.7006, 83.4483);
    assert.deepEqual([r.province.name, r.district.name, r.municipality.name], ["Lumbini Province", "Rupandehi", "Butwal Sub-Metropolitan City"]);
  });
  it("pins outside Nepal are reported as such (Delhi, the equator, the middle of the sea)", async () => {
    for (const [lat, lng] of [[28.6139, 77.209], [0, 0], [10, 90]]) assert.deepEqual(await at(lat, lng), { inNepal: false });
  });
  it("a pin inside a national park gives the area and its district, with no municipality", async () => {
    const r = await at(27.5, 84.45);
    assert.equal(r.inNepal, true); assert.equal(r.municipality, null); assert.match(r.area.name, /National Park/); assert.ok(r.district.id);
  });
  it("is fast enough to call on every pin move (after the first load)", async () => {
    await at(27.7, 85.3); const t0 = performance.now();
    for (let i = 0; i < 50; i++) await at(27.7 + i * 0.001, 85.3 + i * 0.001);
    assert.ok((performance.now() - t0) / 50 < 20, "under ~20 ms per lookup");
  });
  it("a point just across a border, in a hairline gap, snaps to the nearest area within the tolerance and says it's approximate", async () => {
    // Fake tiny dataset: two squares with a 0.0002° (~22 m) gap between them.
    const sq = (x0, x1) => [[x0, 0, x1, 0, x1, 1, x0, 1, x0, 0]];
    const mk = (m, x0, x1) => ({ m, d: "d1", b: [x0, 0, x1, 1], p: [sq(x0, x1)] });
    const g = createGeoService({ load: async () => ({ meta: { prov: { p1: "P1" }, dist: { d1: { n: "D1", p: "p1" } }, muni: { a: { n: "A", w: 5 }, b: { n: "B", w: 7 } } }, features: [mk("a", 0, 0.5), mk("b", 0.5002, 1)] }) });
    const gap = await g.locate(0.5, 0.5001);
    assert.equal(gap.approximate, true); assert.ok(["a", "b"].includes(gap.municipality.id));
    assert.equal((await g.locate(0.5, 0.25)).approximate, false); // well inside square A
    assert.deepEqual(await g.locate(0.5, 5), { inNepal: false }, "far from everything is outside");
  });
  it("holes in a polygon are respected (a pin in the hole is not in the polygon)", async () => {
    const outer = [0, 0, 10, 0, 10, 10, 0, 10, 0, 0]; const hole = [4, 4, 6, 4, 6, 6, 4, 6, 4, 4];
    const g = createGeoService({ load: async () => ({ meta: { prov: { p: "P" }, dist: { d: { n: "D", p: "p" } }, muni: { m: { n: "M", w: 1 } } }, features: [{ m: "m", d: "d", b: [0, 0, 10, 10], p: [[outer, hole]] }] }), edgeToleranceM: 0 });
    assert.equal((await g.locate(2, 2)).municipality.id, "m"); assert.equal((await g.locate(5, 5)).inNepal, false);
  });
});

describe("locate query validation", () => {
  it("needs numeric lat/lng within range", () => {
    assert.equal(locateQuery.safeParse({ lat: "27.7", lng: "85.3" }).success, true);
    assert.equal(locateQuery.safeParse({ lat: "91", lng: "85" }).success, false);
    assert.equal(locateQuery.safeParse({ lat: "x", lng: "85" }).success, false);
    assert.equal(locateQuery.safeParse({ lat: "27" }).success, false);
  });
});
