const crypto = require("crypto");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derivedKey = await scrypt(String(password), salt, 64);
  return `scrypt:${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

async function verifyPassword(password, storedHash) {
  const [algorithm, saltHex, hashHex] = String(storedHash || "").split(":");
  if (algorithm !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(String(password), Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

module.exports = { hashPassword, verifyPassword };

