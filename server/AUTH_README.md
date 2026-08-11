Authentication notes

This project uses PostgreSQL-backed users and revocable cookie sessions.

Setup:

1. Start PostgreSQL with `docker compose up -d postgres` or provide another PostgreSQL database.
2. Copy `server/.env.example` to `server/.env` and configure either
   `DATABASE_URL` or `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, and
   `PGDATABASE`. Also set `ADMIN_USERNAME` and `ADMIN_PASSWORD`.
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

- The current Docker database host is `postgres`, port `5432`, database
  `cic_catalogs`, and user `postgres`. Keep its existing password in the
  untracked environment file rather than this README.
- The hostname `postgres` is available only to containers on the same Docker
  Compose network. An ECS deployment needs a VPC-resolvable database endpoint.

- Passwords are stored as salted scrypt hashes; raw session tokens are never stored.
- In production, HTTPS is required because the session cookie is marked secure.
- Re-running `npm run db:seed` updates the configured administrator password.
