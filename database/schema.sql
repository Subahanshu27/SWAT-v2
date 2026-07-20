-- ===========================================================================
-- SWAT2 schema (shared with the main Floyo Supabase project)
--
-- SWAT2 reuses the same `swat` schema as the original SWAT app. This file is
-- idempotent: it is safe to run multiple times. It only creates the SWAT
-- specific tables/constraints; it does NOT touch the existing public.workflows
-- / users_metadata tables which are owned by the main app.
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS swat;

CREATE TABLE IF NOT EXISTS swat.batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  sequence TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration INTEGER,
  progress INTEGER DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  total_workflows INTEGER DEFAULT 0,
  completed_workflows INTEGER DEFAULT 0,
  failed_workflows INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS swat.batch_workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES swat.batches(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER DEFAULT 0,
  position INTEGER,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  duration INTEGER,
  execution_time INTEGER,
  time_in_queue INTEGER,
  run_id TEXT,
  job_time_submitted TIMESTAMPTZ,
  golden_image_hash TEXT,
  actual_image_hash TEXT,
  error_details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (batch_id, workflow_id)
);

ALTER TABLE swat.batch_workflows ADD COLUMN IF NOT EXISTS error_details JSONB;

ALTER TABLE swat.batches DROP CONSTRAINT IF EXISTS batches_status_check;
ALTER TABLE swat.batches
  ADD CONSTRAINT batches_status_check
  CHECK (status IN ('running', 'completed', 'failed', 'pending', 'cancelled'));
-- Note: prod may omit 'queued'; SWAT2 maps queued → pending on write via toBatchesTableStatus().
-- To allow queued on batches: add 'queued' to the CHECK list above.

ALTER TABLE swat.batch_workflows DROP CONSTRAINT IF EXISTS batch_workflows_status_check;
ALTER TABLE swat.batch_workflows
  ADD CONSTRAINT batch_workflows_status_check
  CHECK (status IN (
    'running', 'completed', 'failed', 'pending', 'passed',
    'cancelled', 'passed-exact', 'passed-acceptable', 'failed-runtime', 'queued',
    'blocked'
  ));

CREATE INDEX IF NOT EXISTS idx_batches_created_at ON swat.batches(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_batch_workflows_batch_id ON swat.batch_workflows(batch_id);
CREATE INDEX IF NOT EXISTS idx_batch_workflows_run_id ON swat.batch_workflows(run_id);
CREATE INDEX IF NOT EXISTS idx_batch_workflows_status ON swat.batch_workflows(status);

ALTER TABLE swat.batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE swat.batch_workflows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "swat2 authenticated all" ON swat.batches;
CREATE POLICY "swat2 authenticated all" ON swat.batches
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "swat2 authenticated all" ON swat.batch_workflows;
CREATE POLICY "swat2 authenticated all" ON swat.batch_workflows
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

GRANT USAGE ON SCHEMA swat TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA swat TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA swat TO anon, authenticated, service_role;
