CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username varchar(100) NOT NULL,
  password_hash text NOT NULL,
  role varchar(20) NOT NULL DEFAULT 'USER' CHECK (role IN ('ADMIN', 'USER')),
  is_active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_key
  ON users (lower(username));

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS catalog_selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  catalog_id varchar(100) NOT NULL,
  catalog_version_id varchar(100),
  catalog_name text,
  site_code varchar(100),
  language varchar(20) NOT NULL DEFAULT 'en-US',
  selection_type varchar(30) NOT NULL DEFAULT 'DAILY_REFRESH'
    CHECK (selection_type IN ('DAILY_REFRESH', 'MANUAL')),
  version_strategy varchar(20) NOT NULL DEFAULT 'LATEST'
    CHECK (version_strategy IN ('LATEST', 'PINNED')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (version_strategy = 'LATEST' OR catalog_version_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS catalog_selections_scope_key
  ON catalog_selections (COALESCE(user_id::text, 'GLOBAL'), catalog_id, language, selection_type);

CREATE TABLE IF NOT EXISTS refresh_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  triggered_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  trigger_type varchar(20) NOT NULL CHECK (trigger_type IN ('SCHEDULED', 'MANUAL')),
  status varchar(20) NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')),
  started_at timestamptz,
  completed_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refresh_run_catalogs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refresh_run_id uuid NOT NULL REFERENCES refresh_runs(id) ON DELETE CASCADE,
  catalog_id varchar(100),
  catalog_version_id varchar(100) NOT NULL,
  status varchar(20) NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')),
  started_at timestamptz,
  completed_at timestamptz,
  error_message text
);

