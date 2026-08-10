const crypto = require("crypto");

function createAuthRepository(pool) {
  const publicUser = (row) => row && ({
    id: row.id,
    username: row.username,
    role: row.role,
    isActive: row.is_active,
  });

  return {
    async findUserByUsername(username) {
      const result = await pool.query(
        "SELECT * FROM users WHERE lower(username) = lower($1) LIMIT 1",
        [username],
      );
      return result.rows[0] || null;
    },
    async createUser(username, passwordHash) {
      const result = await pool.query(
        `INSERT INTO users (username, password_hash, role)
         VALUES ($1, $2, 'USER') RETURNING *`,
        [username, passwordHash],
      );
      return result.rows[0];
    },
    async createSession(userId, tokenHash, expiresAt) {
      await pool.query(
        "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
        [userId, tokenHash, expiresAt],
      );
      await pool.query("UPDATE users SET last_login_at = now() WHERE id = $1", [userId]);
    },
    async findUserBySession(tokenHash) {
      const result = await pool.query(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
           AND u.is_active = true LIMIT 1`,
        [tokenHash],
      );
      return publicUser(result.rows[0]);
    },
    async revokeSession(tokenHash) {
      await pool.query(
        "UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL",
        [tokenHash],
      );
    },
    publicUser,
    hashToken(token) {
      return crypto.createHash("sha256").update(token).digest("hex");
    },
  };
}

module.exports = { createAuthRepository };
