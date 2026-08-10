const test = require("node:test");
const assert = require("node:assert/strict");
const { hashPassword, verifyPassword } = require("../services/passwords");

test("password hashes are salted and verifiable", async () => {
  const first = await hashPassword("correct horse battery staple");
  const second = await hashPassword("correct horse battery staple");

  assert.notEqual(first, second);
  assert.equal(await verifyPassword("correct horse battery staple", first), true);
  assert.equal(await verifyPassword("wrong password", first), false);
});

test("invalid stored password hashes fail closed", async () => {
  assert.equal(await verifyPassword("anything", "invalid"), false);
});
