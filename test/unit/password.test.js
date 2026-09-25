import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashPassword, needsRehash, verifyPassword } from "../../src/utils/password.js";

describe("password hashing (scrypt)", () => {
  it("verifies the right password and rejects wrong ones", async () => {
    const h = await hashPassword("Correct Horse 9");
    assert.ok(await verifyPassword("Correct Horse 9", h));
    assert.ok(!(await verifyPassword("Correct Horse 8", h)));
    assert.ok(!(await verifyPassword("", h)));
  });

  it("uses a fresh salt each time and never embeds the plaintext", async () => {
    const [a, b] = await Promise.all([hashPassword("same-password-1"), hashPassword("same-password-1")]);
    assert.notEqual(a, b);
    assert.ok(!a.includes("same-password-1"));
    assert.match(a, /^scrypt\$32768\$8\$1\$/);
  });

  it("fails closed on malformed stored hashes", async () => {
    for (const bad of [null, undefined, "", "plaintext", "scrypt$x$y$z$a$b", "bcrypt$1$2$3$4$5"]) assert.equal(await verifyPassword("x", bad), false);
  });

  it("flags weaker parameters for transparent upgrade", async () => {
    const weak = await hashPassword("Some-pass-123", { N: 2 ** 12, r: 8, p: 1 });
    assert.ok(await verifyPassword("Some-pass-123", weak));
    assert.equal(needsRehash(weak), true);
    assert.equal(needsRehash(await hashPassword("Some-pass-123")), false);
  });
});
