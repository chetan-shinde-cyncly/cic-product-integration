# Cyncly Catalog Integration Console

A full-stack catalog administration application for reviewing Cyncly catalogs, selecting catalog versions, refreshing product data, scheduling daily refreshes, and downloading generated JSON files.

The application includes a React client, an Express API, PostgreSQL-backed authentication and catalog selections, and a production Docker deployment with Nginx.

## Features

- User sign-up, sign-in, sign-out, and persistent sessions.
- Salted `scrypt` password hashing.
- Revocable database-backed session tokens stored in `httpOnly` cookies.
- Catalog search and active/inactive filtering.
- Catalog JSON inspection and version selection.
- Daily-refresh catalog selection.
- `LATEST` and `PINNED` catalog-version strategies.
- Manual and scheduled catalog refresh workflows.
- Full product-details generation and progress reporting.
- Product-type JSON exports and downloads.
- PostgreSQL persistence for users, sessions, and selections.
- Automatic migration of legacy daily-refresh JSON selections.
- Dockerized React, Node.js, Nginx, and PostgreSQL deployment.
- Persistent Docker volumes for PostgreSQL and generated catalog files.
- Application and database health checks.

## Architecture

```text
Browser
   |
   | HTTP/HTTPS
   v
Nginx / React client
   |
   | /api/* over private Docker network
   v
Node.js / Express API
   |                    |
   |                    +--> Cyncly catalog APIs
   |
   +--> PostgreSQL
   |
   +--> Persistent generated catalog files
```

In Docker, only the Nginx client port is published. PostgreSQL and the Node API stay on a private Docker network.

## Technology

### Client

- React 18
- Vite 5
- Nginx for production hosting and API proxying

### Server

- Node.js 22
- Express 5
- PostgreSQL driver (`pg`)
- Native Node.js cryptography for password and session security

### Deployment

- Docker Engine
- Docker Compose v2
- PostgreSQL 16
- AWS EC2/Application Load Balancer deployment support

## Project structure

```text
cic-product-integration/
|-- client/
|   |-- src/
|   |   |-- components/
|   |   |-- App.jsx
|   |   `-- main.jsx
|   |-- Dockerfile
|   |-- nginx.conf
|   `-- package.json
|-- server/
|   |-- db/
|   |   |-- index.js
|   |   `-- schema.sql
|   |-- helpers/
|   |-- repositories/
|   |-- routes/
|   |-- scheduler/
|   |-- scripts/
|   |-- services/
|   |-- tests/
|   |-- Dockerfile
|   |-- index.js
|   `-- package.json
|-- deploy.env.example
|-- docker-compose.yml
|-- DEPLOYMENT.md
`-- README.md
```

## Prerequisites

For local development:

- Node.js 20 or newer (Node.js 22 recommended)
- npm
- PostgreSQL 16 or newer

For container deployment:

- Docker Desktop on Windows/macOS, or Docker Engine on Linux
- Docker Compose v2

## Environment variables

### Local server environment

Copy the server template:

```powershell
Copy-Item server\.env.example server\.env
```

Important server variables:

| Variable | Purpose |
|---|---|
| `PORT` | Express API port; default is `5100`. |
| `DATABASE_URL` | PostgreSQL connection URL. |
| `DATABASE_SSL` | Enable PostgreSQL TLS for an external managed database. |
| `PGHOST` | PostgreSQL host used when `DATABASE_URL` is not set. |
| `PGPORT` | PostgreSQL port, normally `5432`. |
| `PGUSER` | Existing PostgreSQL user. |
| `PGPASSWORD` | Existing PostgreSQL password; keep it outside Git. |
| `PGDATABASE` | PostgreSQL database name. |
| `ADMIN_USERNAME` | Administrator created by the seed command. |
| `ADMIN_PASSWORD` | Administrator password used by the seed command. |
| `COOKIE_SECURE` | `false` for local HTTP; `true` for production HTTPS. |
| `DAILY_REFRESH_ENABLED` | Enables or disables the scheduler. |
| `DAILY_REFRESH_HOUR_IST` | Scheduled refresh hour in India Standard Time. |
| `DAILY_REFRESH_MINUTE_IST` | Scheduled refresh minute. |
| `DAILY_REFRESH_LANG` | Catalog language, normally `en-US`. |
| `DAILY_REFRESH_SPACING_MINUTES` | Delay between scheduled catalog jobs. |

### Docker deployment environment

Copy the deployment template:

```powershell
Copy-Item deploy.env.example deploy.env
```

`deploy.env` contains deployment secrets and is ignored by Git. Never commit it.

Use long, unique, URL-safe passwords. For the PostgreSQL password, prefer letters, numbers, `_`, and `-` because it is included in a connection URL.

## Local development without Docker

### 1. Create PostgreSQL database and user

Connect using a PostgreSQL administrator account and run:

```sql
CREATE USER cic_user WITH PASSWORD 'choose_a_secure_password';
CREATE DATABASE cic_catalogs OWNER cic_user;
```

Set the matching connection URL in `server/.env`:

```env
DATABASE_URL=postgresql://cic_user:choose_a_secure_password@localhost:5432/cic_catalogs
DATABASE_SSL=false
COOKIE_SECURE=false
```

Use the actual PostgreSQL port from your installation. Some Windows installations use `5433` instead of `5432`.

Alternatively, configure the existing server database with separate PostgreSQL
variables. For the current Docker deployment, the non-secret values are:

```env
PGHOST=postgres
PGPORT=5432
PGUSER=postgres
PGDATABASE=cic_catalogs
PGPASSWORD=<existing-server-password>
DATABASE_SSL=false
```

The hostname `postgres` is the Docker Compose service name and resolves only
from containers attached to the same Compose network. Keep the existing
password in the untracked `.env`/`deploy.env` file or a secret manager; do not
add it to this README or commit it.

### 2. Install dependencies

```powershell
cd server
npm install

cd ..\client
npm install
```

### 3. Initialize the database

```powershell
cd server
npm run db:init
npm run db:seed
```

`db:init` creates or updates the application tables. `db:seed` creates or updates the configured administrator.

### 4. Start the API

```powershell
cd server
npm run dev
```

The API runs at:

```text
http://localhost:5100
```

### 5. Start the React client

Open another terminal:

```powershell
cd client
npm run dev
```

Open the Vite URL, normally:

```text
http://localhost:5173
```

## Docker Desktop deployment

### 1. Start Docker Desktop

Wait until Docker reports that the engine is running:

```powershell
docker --version
docker compose version
```

### 2. Configure the deployment

From the repository root:

```powershell
Copy-Item deploy.env.example deploy.env
notepad deploy.env
```

Recommended local values:

```env
POSTGRES_DB=cic_catalogs
POSTGRES_USER=cic_user
POSTGRES_PASSWORD=replace_with_a_long_url_safe_password

ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace_with_a_different_long_password

APP_PORT=8080
COOKIE_SECURE=false

DAILY_REFRESH_ENABLED=true
DAILY_REFRESH_HOUR_IST=9
DAILY_REFRESH_MINUTE_IST=10
DAILY_REFRESH_LANG=en-US
DAILY_REFRESH_SPACING_MINUTES=5
```

### 3. Build and start all containers

```powershell
docker compose --env-file deploy.env up -d --build
```

### 4. Seed the administrator

```powershell
docker compose --env-file deploy.env --profile tools run --rm seed-admin
```

### 5. Verify the deployment

```powershell
docker compose --env-file deploy.env ps
```

When `APP_PORT=8080`, open:

```text
Application:   http://localhost:8080
Client health: http://localhost:8080/health
API health:    http://localhost:8080/api/health
```

The API health endpoint should return:

```json
{
  "status": "healthy",
  "database": "connected"
}
```

### Docker logs

```powershell
docker compose --env-file deploy.env logs --tail=200
docker compose --env-file deploy.env logs --tail=200 server
docker compose --env-file deploy.env logs --tail=200 postgres
docker compose --env-file deploy.env logs --tail=200 client
```

### Stop without deleting data

```powershell
docker compose --env-file deploy.env down
```

### Delete all local Docker data

The following command permanently deletes the Docker PostgreSQL and generated-catalog volumes:

```powershell
docker compose --env-file deploy.env down -v
```

After deleting the volumes, start the stack and seed the administrator again.

## Linux server deployment

Recommended host requirements:

- Ubuntu 22.04 or 24.04
- 2 or more vCPUs
- 4 GB or more RAM
- Encrypted disk storage sized for PostgreSQL and generated catalogs
- Docker Engine and Compose v2

Deploy:

```bash
git clone <repository-url>
cd cic-product-integration
cp deploy.env.example deploy.env
nano deploy.env

docker compose --env-file deploy.env up -d --build
docker compose --env-file deploy.env --profile tools run --rm seed-admin
docker compose --env-file deploy.env ps
```

For an HTTP-only test server, use:

```env
COOKIE_SECURE=false
```

For production behind HTTPS, use:

```env
COOKIE_SECURE=true
```

## AWS deployment recommendation

For a straightforward single-server deployment:

1. Run Docker Compose on an EC2 instance.
2. Keep the EC2 instance behind an Application Load Balancer.
3. Terminate HTTPS at the load balancer using AWS Certificate Manager.
4. Forward the load balancer target group to the EC2 application port.
5. Configure the target-group health check as `/health`.
6. Point Route 53 or the client's DNS provider to the load balancer.
7. Use an encrypted EBS volume and AWS Backup snapshots.
8. Prefer Systems Manager Session Manager instead of public SSH.
9. Restrict security groups so PostgreSQL and the Node API are never publicly reachable.

For higher availability, deploy the client/API using ECS or another container service and replace the PostgreSQL container with Amazon RDS PostgreSQL.

### Information required from the AWS client

- AWS account ID and deployment region.
- EC2 Compose or ECS/RDS deployment preference.
- Approved instance size and budget.
- VPC, subnet, and security-group requirements.
- Domain name and DNS ownership.
- Existing Application Load Balancer and ACM certificate information.
- IAM role, AWS SSO, or least-privilege deployment access.
- Systems Manager or SSH access requirements.
- Approved SSH source addresses if SSH is used.
- Storage capacity and backup retention requirements.
- Monitoring and alert recipients.
- GitHub organization/repository ownership.
- Whether GitHub Actions CI/CD is required.

Never request or commit AWS root credentials, access keys, SSH private keys, database passwords, or administrator passwords. Use IAM roles/SSO, AWS Secrets Manager, GitHub Actions Secrets, or the untracked `deploy.env` file.

## Database schema

The server initializes these PostgreSQL tables:

- `users`: user accounts, roles, password hashes, and activation state.
- `sessions`: revocable hashed session tokens and expiration dates.
- `catalog_selections`: daily/manual selection strategy and pinned versions.
- `refresh_runs`: scheduled and manual refresh-run metadata.
- `refresh_run_catalogs`: status of each catalog in a refresh run.

Generated product payloads remain in persistent files rather than being stored as large database records.

## Authentication

Available endpoints:

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/auth/signup` | Create a standard user and start a session. |
| `POST` | `/api/auth/login` | Authenticate and start a session. |
| `POST` | `/api/auth/logout` | Revoke the current session. |
| `GET` | `/api/auth/me` | Return the authenticated user. |

The raw session token exists only in the browser cookie. PostgreSQL stores a SHA-256 token hash. Passwords are stored as salted `scrypt` hashes.

## Catalog selection behavior

- `LATEST`: the scheduler resolves the newest available catalog version when it runs.
- `PINNED`: the scheduler always uses the explicitly selected version.

Daily-refresh selection mutations require authentication. Existing legacy selections from `server/catalogs/daily-refresh-selection.json` are imported into PostgreSQL as `LATEST` selections when no database selection exists.

## Backups

Create a PostgreSQL backup from Docker:

```bash
docker compose --env-file deploy.env exec -T postgres \
  pg_dump -U cic_user -d cic_catalogs -Fc > cic_catalogs_$(date +%F).dump
```

Back up both:

- The PostgreSQL data volume.
- The generated catalog volume.

Use automated encrypted snapshots and periodically test restoration.

## Testing and validation

### Server tests

```powershell
cd server
npm test
```

### Client lint

```powershell
cd client
npm run lint
```

### Client production build

```powershell
cd client
npm run build
```

## Common troubleshooting

### Signup endpoint is not found

An older server process is probably still running. Stop and restart the API or rebuild the server container:

```powershell
docker compose --env-file deploy.env up -d --build server client
```

### Login succeeds but the session is immediately lost

For local HTTP testing:

```env
COOKIE_SECURE=false
```

Use `COOKIE_SECURE=true` only when the browser accesses the application through HTTPS.

### Database connection refused

- Verify PostgreSQL is running.
- Verify the configured port.
- Verify `DATABASE_URL` or the Docker deployment variables.
- Check PostgreSQL logs.

```powershell
docker compose --env-file deploy.env logs --tail=200 postgres server
```

### Password authentication failed for PostgreSQL

Docker applies `POSTGRES_PASSWORD` only when it creates a new empty PostgreSQL volume. Changing the environment variable later does not change an existing database password.

For disposable local data, reset the volumes and recreate the stack:

```powershell
docker compose --env-file deploy.env down -v
docker compose --env-file deploy.env up -d --build
```

Do not run `down -v` against production unless permanent data deletion is explicitly intended and verified backups exist.

### Port is already in use

Change `APP_PORT` in `deploy.env`, for example:

```env
APP_PORT=8081
```

Then recreate the client container:

```powershell
docker compose --env-file deploy.env up -d
```

## Security notes

- Never commit `.env`, `deploy.env`, certificates, database dumps, or cloud credentials.
- Use different passwords for PostgreSQL and the application administrator.
- Use HTTPS in production.
- Restrict EC2 and database networking.
- Keep Docker, Linux, Node.js, Nginx, and PostgreSQL updated.
- Regularly review user accounts and revoke unused access.
- Maintain tested database and catalog-file backups.
- Prefer AWS IAM roles and SSO over long-lived access keys.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the focused deployment runbook.
