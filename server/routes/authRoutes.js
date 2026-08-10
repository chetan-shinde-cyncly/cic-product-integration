const crypto = require("crypto");
const { hashPassword, verifyPassword } = require("../services/passwords");

const COOKIE_NAME = "cicSession";
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const separator = part.indexOf("=");
    return separator < 0 ? [part, ""] : [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
  }));
}

function cookieOptions() {
  const secure = process.env.COOKIE_SECURE
    ? String(process.env.COOKIE_SECURE).toLowerCase() === "true"
    : process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: SESSION_MS,
  };
}

function createAuthMiddleware(repository) {
  async function optionalAuth(req, _res, next) {
    try {
      const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
      req.user = token ? await repository.findUserBySession(repository.hashToken(token)) : null;
      req.sessionToken = token || null;
      next();
    } catch (error) {
      next(error);
    }
  }

  function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ message: "Authentication required." });
    next();
  }

  return { optionalAuth, requireAuth };
}

function registerAuthRoutes(app, repository, requireAuth) {
  async function startSession(res, user) {
    const token = crypto.randomBytes(32).toString("base64url");
    await repository.createSession(user.id, repository.hashToken(token), new Date(Date.now() + SESSION_MS));
    res.cookie(COOKIE_NAME, token, cookieOptions());
    return repository.publicUser(user);
  }

  app.post("/api/auth/signup", async (req, res, next) => {
    try {
      const username = String(req.body?.username || "").trim();
      const password = String(req.body?.password || "");
      if (!/^[a-zA-Z0-9._-]{3,50}$/.test(username)) {
        return res.status(400).json({ message: "Username must be 3-50 characters and use only letters, numbers, dots, underscores, or hyphens." });
      }
      if (password.length < 8 || password.length > 128) {
        return res.status(400).json({ message: "Password must be between 8 and 128 characters." });
      }
      const user = await repository.createUser(username, await hashPassword(password));
      const publicUser = await startSession(res, user);
      return res.status(201).json({ message: "Account created.", user: publicUser });
    } catch (error) {
      if (error?.code === "23505") {
        return res.status(409).json({ message: "That username is already registered." });
      }
      next(error);
    }
  });

  app.post("/api/auth/login", async (req, res, next) => {
    try {
      const username = String(req.body?.username || "").trim();
      const password = String(req.body?.password || "");
      if (!username || !password) return res.status(400).json({ message: "Username and password are required." });
      const user = await repository.findUserByUsername(username);
      if (!user || !user.is_active || !(await verifyPassword(password, user.password_hash))) {
        return res.status(401).json({ message: "Invalid username or password." });
      }
      const publicUser = await startSession(res, user);
      return res.json({ message: "Authentication successful.", user: publicUser });
    } catch (error) { next(error); }
  });

  app.get("/api/auth/me", requireAuth, (req, res) => res.json({ user: req.user }));
  app.post("/api/auth/logout", async (req, res, next) => {
    try {
      if (req.sessionToken) await repository.revokeSession(repository.hashToken(req.sessionToken));
      res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });
      res.json({ message: "Logged out." });
    } catch (error) { next(error); }
  });
}

module.exports = { createAuthMiddleware, registerAuthRoutes };
