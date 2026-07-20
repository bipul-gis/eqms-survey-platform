-- EQMS GeoSurvey — PostgreSQL schema (database: eqms-geosurvey)

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  mobile_number TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'enumerator')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  landmark_icon_scale REAL,
  assigned_ward_name TEXT,
  assigned_ward_names JSONB NOT NULL DEFAULT '[]'::jsonb,
  project_ward_assignments JSONB NOT NULL DEFAULT '{}'::jsonb,
  assigned_questionnaire_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  assigned_slum_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  project_slum_assignments JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_token ON auth_sessions(token);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);

CREATE TABLE IF NOT EXISTS deleted_users (
  uid TEXT PRIMARY KEY,
  email TEXT,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_by TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS deleted_user_emails (
  email_key TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS questionnaires (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_questionnaires_project ON questionnaires(project_id);

CREATE TABLE IF NOT EXISTS questionnaire_responses (
  id TEXT PRIMARY KEY,
  questionnaire_id TEXT NOT NULL REFERENCES questionnaires(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  respondent_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qr_questionnaire ON questionnaire_responses(questionnaire_id);
CREATE INDEX IF NOT EXISTS idx_qr_respondent ON questionnaire_responses(respondent_id);
CREATE INDEX IF NOT EXISTS idx_qr_status ON questionnaire_responses(status);

CREATE TABLE IF NOT EXISTS features (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_by_uid TEXT,
  created_by TEXT,
  task_ward TEXT,
  ward_name TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_features_created_by_uid ON features(created_by_uid);
CREATE INDEX IF NOT EXISTS idx_features_created_by ON features(created_by);
CREATE INDEX IF NOT EXISTS idx_features_task_ward ON features(task_ward);
CREATE INDEX IF NOT EXISTS idx_features_ward_name ON features(ward_name);
CREATE INDEX IF NOT EXISTS idx_features_status ON features(status);

-- Legacy Firebase project id → MIS project id (for migrated questionnaires)
CREATE TABLE IF NOT EXISTS project_id_map (
  legacy_id TEXT PRIMARY KEY,
  mis_project_id TEXT NOT NULL,
  mis_project_code TEXT,
  mis_project_name TEXT,
  mapped_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS geosurvey_projects (
  project_id TEXT PRIMARY KEY,
  project_code TEXT NOT NULL DEFAULT '',
  project_name TEXT NOT NULL DEFAULT '',
  manager_name TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  project_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
