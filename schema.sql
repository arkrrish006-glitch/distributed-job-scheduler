CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enums
DO $$ BEGIN
    CREATE TYPE job_status AS ENUM ('QUEUED', 'SCHEDULED', 'CLAIMED', 'RUNNING', 'COMPLETED', 'FAILED', 'DEAD_LETTER');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE job_type AS ENUM ('IMMEDIATE', 'DELAYED', 'RECURRING', 'BATCH');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE backoff_strategy AS ENUM ('FIXED', 'LINEAR', 'EXPONENTIAL');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE worker_status AS ENUM ('ONLINE', 'OFFLINE', 'DRAINING');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 1. Organizations & Users
CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'MEMBER',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Projects & Retry Policies
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    api_key VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS retry_policies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    max_retries INT DEFAULT 3,
    strategy backoff_strategy DEFAULT 'EXPONENTIAL',
    base_delay_seconds INT DEFAULT 5,
    max_delay_seconds INT DEFAULT 300
);

-- 3. Queues
CREATE TABLE IF NOT EXISTS queues (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    priority INT DEFAULT 1,
    concurrency_limit INT DEFAULT 10,
    is_paused BOOLEAN DEFAULT FALSE,
    retry_policy_id UUID REFERENCES retry_policies(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(project_id, name)
);

-- 4. Workers & Heartbeats
CREATE TABLE IF NOT EXISTS workers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hostname VARCHAR(255) NOT NULL,
    pid INT NOT NULL,
    status worker_status DEFAULT 'ONLINE',
    concurrency INT DEFAULT 5,
    current_load INT DEFAULT 0,
    last_heartbeat TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS worker_heartbeats (
    id BIGSERIAL PRIMARY KEY,
    worker_id UUID REFERENCES workers(id) ON DELETE CASCADE,
    cpu_usage NUMERIC(5,2) DEFAULT 0.00,
    memory_usage NUMERIC(5,2) DEFAULT 0.00,
    active_jobs INT DEFAULT 0,
    recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Jobs & Scheduled Jobs
CREATE TABLE IF NOT EXISTS jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    queue_id UUID REFERENCES queues(id) ON DELETE CASCADE,
    job_type job_type DEFAULT 'IMMEDIATE',
    status job_status DEFAULT 'QUEUED',
    priority INT DEFAULT 1,
    payload JSONB NOT NULL,
    result JSONB,
    idempotency_key VARCHAR(255),
    max_retries INT DEFAULT 3,
    retry_count INT DEFAULT 0,
    scheduled_for TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    claimed_by UUID REFERENCES workers(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    queue_id UUID REFERENCES queues(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    cron_expression VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    last_run_at TIMESTAMP WITH TIME ZONE,
    next_run_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. Executions, Logs, DLQ
CREATE TABLE IF NOT EXISTS job_executions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id UUID REFERENCES jobs(id) ON DELETE CASCADE,
    worker_id UUID REFERENCES workers(id) ON DELETE SET NULL,
    attempt INT NOT NULL,
    status job_status NOT NULL,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    finished_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    execution_time_ms INT
);

CREATE TABLE IF NOT EXISTS job_logs (
    id BIGSERIAL PRIMARY KEY,
    job_id UUID REFERENCES jobs(id) ON DELETE CASCADE,
    execution_id UUID REFERENCES job_executions(id) ON DELETE CASCADE,
    level VARCHAR(20) DEFAULT 'INFO',
    message TEXT NOT NULL,
    logged_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dead_letter_queue (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id UUID REFERENCES jobs(id) ON DELETE CASCADE,
    queue_id UUID REFERENCES queues(id) ON DELETE CASCADE,
    failed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    total_retries INT,
    last_error TEXT,
    original_payload JSONB
);

-- Production Indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency ON jobs (queue_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_claim_covering ON jobs (status, scheduled_for, priority DESC, created_at ASC) WHERE status IN ('QUEUED', 'SCHEDULED');
CREATE INDEX IF NOT EXISTS idx_jobs_queue_active ON jobs (queue_id) WHERE status IN ('CLAIMED', 'RUNNING');
CREATE INDEX IF NOT EXISTS idx_worker_heartbeat_status ON workers (last_heartbeat, status);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due ON scheduled_jobs (is_active, next_run_at) WHERE is_active = TRUE;