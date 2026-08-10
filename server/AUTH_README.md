Authentication notes

This project uses PostgreSQL-backed users and revocable cookie sessions.

Setup:

1. Start PostgreSQL with `docker compose up -d postgres` or provide another PostgreSQL database.
2. Copy `server/.env.example` to `server/.env` and set `DATABASE_URL`, `ADMIN_USERNAME`, and `ADMIN_PASSWORD`.
3. Run `npm run db:init` and `npm run db:seed` from `server`.
4. Start the server with `npm start`.

Endpoints:

- POST /api/auth/signup
  - Body: { "username": "...", "password": "..." }
  - Creates a normal user account and signs it in.
- POST /api/auth/login
  - Body: { "username": "...", "password": "..." }
  - Sets a random `cicSession` httpOnly cookie on success.
- POST /api/auth/logout
  - Clears the auth cookie.
- GET /api/auth/me
  - Returns { user } when authenticated.

Notes:

- Passwords are stored as salted scrypt hashes; raw session tokens are never stored.
- In production, HTTPS is required because the session cookie is marked secure.
- Re-running `npm run db:seed` updates the configured administrator password.
