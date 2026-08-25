import express, { Response } from 'express';
import cors from 'cors';
import * as bcrypt from 'bcryptjs';
const cronParser = require('cron-parser');
import rateLimit from 'express-rate-limit';
import { pool } from '../db';
import { generateToken, generateSecureApiKey, requireAuth, requireRole, AuthRequest } from './auth';
import { startCronService } from '../worker/cronScheduler';

const app = express();
app.use(cors());
app.use(express.json());

// Rate Limiter for Ingestion Routes (Bonus)
const ingestionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests. Please try again later.' } }
});

startCronService(5000);

// --- 1. AUTHENTICATION ROUTES ---
app.post('/api/auth/register', async (req, res) => {
  const { org_name, email, password } = req.body;
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Email and password (min 6 chars) required.' } });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orgRes = await client.query(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [org_name || `${email}'s Org`]);
    const orgId = orgRes.rows[0].id;

    const hash = await bcrypt.hash(password, 10);
    const userRes = await client.query(
      `INSERT INTO users (org_id, email, password_hash, role) VALUES ($1, $2, $3, 'ADMIN') RETURNING id, org_id, email, role`,
      [orgId, email.toLowerCase(), hash]
    );
    await client.query('COMMIT');

    const user = userRes.rows[0];
    const token = generateToken(user);
    res.status(201).json({ user, token });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(409).json({ error: { code: 'USER_EXISTS', message: 'User already exists.' } });
  } finally {
    client.release();
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const userRes = await pool.query(`SELECT * FROM users WHERE email = $1`, [email.toLowerCase()]);
    if (userRes.rows.length === 0) {
      return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials.' } });
    }
    const user = userRes.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials.' } });
    }

    const token = generateToken({ id: user.id, org_id: user.org_id, email: user.email, role: user.role });
    res.json({ token, user: { id: user.id, org_id: user.org_id, email: user.email, role: user.role } });
  } catch (err: any) {
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

app.get('/api/auth/me', requireAuth, (req: AuthRequest, res: Response) => {
  res.json({ user: req.user });
});

// --- 2. PROJECTS (Org-Scoped) ---
app.post('/api/projects', requireAuth, async (req: AuthRequest, res: Response) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Project name required.' } });
  try {
    const apiKey = generateSecureApiKey();
    const result = await pool.query(
      `INSERT INTO projects (org_id, name, api_key) VALUES ($1, $2, $3) RETURNING *`,
      [req.user!.org_id, name, apiKey]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

app.get('/api/projects', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(`SELECT * FROM projects WHERE org_id = $1 ORDER BY created_at DESC`, [req.user!.org_id]);
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

app.get('/api/projects/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(`SELECT * FROM projects WHERE id = $1 AND org_id = $2`, [req.params.id, req.user!.org_id]);
    if (result.rows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found.' } });
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// --- 3. QUEUES (Org-Scoped) ---
app.get('/api/queues', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT q.*, p.name as project_name, rp.name as retry_policy_name 
       FROM queues q 
       JOIN projects p ON q.project_id = p.id 
       LEFT JOIN retry_policies rp ON q.retry_policy_id = rp.id 
       WHERE p.org_id = $1 ORDER BY q.created_at DESC`,
      [req.user!.org_id]
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

app.post('/api/queues', requireAuth, async (req: AuthRequest, res: Response) => {
  const { project_id, name, priority, concurrency_limit, retry_policy_id } = req.body;
  if (!project_id || !name) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'project_id and name required.' } });
  
  // Verify Project belongs to authenticated Org
  const projCheck = await pool.query(`SELECT id FROM projects WHERE id = $1 AND org_id = $2`, [project_id, req.user!.org_id]);
  if (projCheck.rows.length === 0) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Unauthorized project access.' } });
  }

  try {
    const result = await pool.query(
      `INSERT INTO queues (project_id, name, priority, concurrency_limit, retry_policy_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [project_id, name, priority || 1, concurrency_limit || 10, retry_policy_id || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } });
  }
});

app.patch('/api/queues/:id', requireAuth, requireRole(['ADMIN']), async (req: AuthRequest, res: Response) => {
  const { is_paused, concurrency_limit, priority } = req.body;
  try {
    const result = await pool.query(
      `UPDATE queues q
       SET is_paused = COALESCE($1, q.is_paused),
           concurrency_limit = COALESCE($2, q.concurrency_limit),
           priority = COALESCE($3, q.priority)
       FROM projects p
       WHERE q.id = $4 AND q.project_id = p.id AND p.org_id = $5
       RETURNING q.*`,
      [is_paused, concurrency_limit, priority, req.params.id, req.user!.org_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Queue not found in your organization.' } });
    res.json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

app.get('/api/queues/:id/stats', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const stats = await pool.query(
      `SELECT j.status, COUNT(*)::int as count 
       FROM jobs j
       JOIN queues q ON j.queue_id = q.id
       JOIN projects p ON q.project_id = p.id
       WHERE q.id = $1 AND p.org_id = $2
       GROUP BY j.status`,
      [req.params.id, req.user!.org_id]
    );
    const dlq = await pool.query(
      `SELECT COUNT(*)::int as dlq_count 
       FROM dead_letter_queue dlq
       JOIN queues q ON dlq.queue_id = q.id
       JOIN projects p ON q.project_id = p.id
       WHERE dlq.queue_id = $1 AND p.org_id = $2`,
      [req.params.id, req.user!.org_id]
    );
    res.json({ queue_id: req.params.id, stats: stats.rows, dlq: dlq.rows[0]?.dlq_count || 0 });
  } catch (err: any) {
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// --- 4. JOBS (Org-Scoped Ingestion & Listing) ---
app.post('/api/jobs', requireAuth, ingestionLimiter, async (req: AuthRequest, res: Response) => {
  const { queue_id, job_type, payload, priority, delay_seconds, max_retries } = req.body;
  const idempotencyKey = req.headers['idempotency-key'] as string;

  if (!queue_id || !payload) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'queue_id and payload required.' } });
  }

  // Tenant Isolation Verification
  const queueCheck = await pool.query(
    `SELECT q.id FROM queues q JOIN projects p ON q.project_id = p.id WHERE q.id = $1 AND p.org_id = $2`,
    [queue_id, req.user!.org_id]
  );
  if (queueCheck.rows.length === 0) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Queue does not belong to your organization.' } });
  }

  try {
    if (idempotencyKey) {
      const existing = await pool.query(`SELECT * FROM jobs WHERE queue_id = $1 AND idempotency_key = $2`, [queue_id, idempotencyKey]);
      if (existing.rows.length > 0) return res.status(200).json(existing.rows[0]);
    }

    const scheduledFor = delay_seconds && delay_seconds > 0 ? new Date(Date.now() + delay_seconds * 1000) : new Date();
    const determinedType = delay_seconds && delay_seconds > 0 ? 'DELAYED' : (job_type || 'IMMEDIATE');
    const initialStatus = delay_seconds && delay_seconds > 0 ? 'SCHEDULED' : 'QUEUED';

    const result = await pool.query(
      `INSERT INTO jobs (queue_id, job_type, payload, priority, scheduled_for, status, idempotency_key, max_retries)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [queue_id, determinedType, payload, priority || 1, scheduledFor, initialStatus, idempotencyKey || null, max_retries || 3]
    );

    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } });
  }
});

app.post('/api/jobs/batch', requireAuth, ingestionLimiter, async (req: AuthRequest, res: Response) => {
  const { queue_id, jobs } = req.body;
  if (!queue_id || !Array.isArray(jobs) || jobs.length === 0) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'queue_id and jobs array required.' } });
  }

  const queueCheck = await pool.query(
    `SELECT q.id FROM queues q JOIN projects p ON q.project_id = p.id WHERE q.id = $1 AND p.org_id = $2`,
    [queue_id, req.user!.org_id]
  );
  if (queueCheck.rows.length === 0) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Unauthorized queue access.' } });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const createdJobs = [];
    for (const item of jobs) {
      const resItem = await client.query(
        `INSERT INTO jobs (queue_id, job_type, payload, priority, status)
         VALUES ($1, 'BATCH', $2, $3, 'QUEUED') RETURNING id, status, created_at`,
        [queue_id, item.payload || {}, item.priority || 1]
      );
      createdJobs.push(resItem.rows[0]);
    }
    await client.query('COMMIT');
    res.status(201).json({ created_count: createdJobs.length, jobs: createdJobs });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { code: 'BATCH_INSERT_FAILED', message: err.message } });
  } finally {
    client.release();
  }
});

app.post('/api/scheduled-jobs', requireAuth, async (req: AuthRequest, res: Response) => {
  const { queue_id, name, cron_expression, payload } = req.body;
  if (!queue_id || !cron_expression || !name) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'queue_id, name, and cron_expression required.' } });
  }

  const queueCheck = await pool.query(
    `SELECT q.id FROM queues q JOIN projects p ON q.project_id = p.id WHERE q.id = $1 AND p.org_id = $2`,
    [queue_id, req.user!.org_id]
  );
  if (queueCheck.rows.length === 0) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Unauthorized queue access.' } });
  }

  try {
    const interval = cronParser.parseExpression(cron_expression);
    const nextRun = interval.next().toDate();

    const result = await pool.query(
      `INSERT INTO scheduled_jobs (queue_id, name, cron_expression, payload, next_run_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [queue_id, name, cron_expression, payload || {}, nextRun]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    res.status(400).json({ error: { code: 'INVALID_CRON', message: `Invalid cron: ${err.message}` } });
  }
});

app.get('/api/jobs', requireAuth, async (req: AuthRequest, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = Math.min(100, parseInt(req.query.limit as string) || 20);
  const offset = (page - 1) * limit;

  const { status, queue_id, job_type } = req.query;
  const conditions: string[] = ['p.org_id = $1'];
  const params: any[] = [req.user!.org_id];

  if (status) {
    params.push(status);
    conditions.push(`j.status = $${params.length}`);
  }
  if (queue_id) {
    params.push(queue_id);
    conditions.push(`j.queue_id = $${params.length}`);
  }
  if (job_type) {
    params.push(job_type);
    conditions.push(`j.job_type = $${params.length}`);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  try {
    const countRes = await pool.query(
      `SELECT COUNT(*)::int as total 
       FROM jobs j 
       JOIN queues q ON j.queue_id = q.id 
       JOIN projects p ON q.project_id = p.id 
       ${whereClause}`,
      params
    );
    const total = countRes.rows[0].total;

    const dataRes = await pool.query(
      `SELECT j.*, q.name as queue_name, w.hostname as worker_hostname
       FROM jobs j
       JOIN queues q ON j.queue_id = q.id
       JOIN projects p ON q.project_id = p.id
       LEFT JOIN workers w ON j.claimed_by = w.id
       ${whereClause}
       ORDER BY j.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.json({
      data: dataRes.rows,
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) }
    });
  } catch (err: any) {
    res.status(500).json({ error: { code: 'QUERY_FAILED', message: err.message } });
  }
});

// --- 5. INFRASTRUCTURE OBSERVABILITY (Global Fleet / Auth Protected) ---
app.get('/api/workers', requireAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT *,
       CASE
         WHEN last_heartbeat > NOW() - INTERVAL '15 seconds' AND status != 'OFFLINE' THEN 'ONLINE'
         ELSE 'OFFLINE'
       END as live_status
       FROM workers ORDER BY last_heartbeat DESC`
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

app.get('/api/metrics', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const jobStats = await pool.query(
      `SELECT j.status, COUNT(*)::int as count 
       FROM jobs j
       JOIN queues q ON j.queue_id = q.id
       JOIN projects p ON q.project_id = p.id
       WHERE p.org_id = $1
       GROUP BY j.status`,
      [req.user!.org_id]
    );
    const workerStats = await pool.query(
      `SELECT COUNT(*)::int as active_workers 
       FROM workers 
       WHERE last_heartbeat > NOW() - INTERVAL '15 seconds' AND status = 'ONLINE'`
    );
    res.json({
      jobs: jobStats.rows,
      active_workers: workerStats.rows[0]?.active_workers || 0
    });
  } catch (err: any) {
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// --- 6. DLQ RE-QUEUE RETRY (Org Scoped & Role Restricted) ---
app.post('/api/dlq/:job_id/retry', requireAuth, requireRole(['ADMIN']), async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jobRes = await client.query(
      `UPDATE jobs j
       SET status = 'QUEUED', retry_count = 0, scheduled_for = NOW(), updated_at = NOW()
       FROM queues q, projects p
       WHERE j.id = $1 AND j.queue_id = q.id AND q.project_id = p.id AND p.org_id = $2
       RETURNING j.*`,
      [req.params.job_id, req.user!.org_id]
    );
    if (jobRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Job not found in your organization.' } });
    }
    await client.query(`DELETE FROM dead_letter_queue WHERE job_id = $1`, [req.params.job_id]);
    await client.query(
      `INSERT INTO job_logs (job_id, level, message) VALUES ($1, 'INFO', 'Job manually re-queued from DLQ')`,
      [req.params.job_id]
    );
    await client.query('COMMIT');
    res.json({ message: 'Job re-queued successfully', job: jobRes.rows[0] });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { code: 'RETRY_FAILED', message: err.message } });
  } finally {
    client.release();
  }
});

// --- 7. EMBEDDED DASHBOARD WITH AUTH TOKEN INPUT ---
app.get('/', (_req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Codity Job Scheduler Platform</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 font-sans p-8">
  <div class="max-w-7xl mx-auto space-y-6">
    <div class="flex justify-between items-center border-b border-slate-800 pb-4">
      <div>
        <h1 class="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
          ⚡ Distributed Job Scheduler
        </h1>
        <p class="text-xs text-slate-400">PostgreSQL SKIP LOCKED Concurrency & Multi-Worker Fleet</p>
      </div>
      <div class="flex items-center gap-3">
        <input id="authToken" type="password" placeholder="Paste Bearer Token or x-api-key" class="bg-slate-900 border border-slate-700 rounded px-3 py-1 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 w-64" />
        <button onclick="loadData()" class="bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1 rounded text-xs">Authorize</button>
        <div class="flex items-center gap-2 bg-emerald-950/80 border border-emerald-700/60 px-3 py-1 rounded-full text-emerald-300 text-xs font-semibold">
          <span class="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span> Live (2s)
        </div>
      </div>
    </div>

    <!-- Metrics -->
    <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
      <div class="bg-slate-900 p-4 rounded border border-slate-800"><p class="text-[10px] uppercase text-slate-400">Active Workers</p><p id="statWorkers" class="text-2xl font-bold mt-1 text-white">0</p></div>
      <div class="bg-slate-900 p-4 rounded border border-slate-800"><p class="text-[10px] uppercase text-slate-400">Queued / Scheduled</p><p id="statQueued" class="text-2xl font-bold mt-1 text-amber-400">0</p></div>
      <div class="bg-slate-900 p-4 rounded border border-slate-800"><p class="text-[10px] uppercase text-slate-400">Running / Claimed</p><p id="statRunning" class="text-2xl font-bold mt-1 text-indigo-400">0</p></div>
      <div class="bg-slate-900 p-4 rounded border border-slate-800"><p class="text-[10px] uppercase text-slate-400">Completed</p><p id="statCompleted" class="text-2xl font-bold mt-1 text-emerald-400">0</p></div>
      <div class="bg-slate-900 p-4 rounded border border-slate-800"><p class="text-[10px] uppercase text-slate-400">Dead Letter (DLQ)</p><p id="statDLQ" class="text-2xl font-bold mt-1 text-rose-400">0</p></div>
    </div>

    <!-- Enqueue & Workers -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
      <div class="bg-slate-900 p-5 rounded border border-slate-800 space-y-3">
        <h2 class="text-sm font-semibold text-white">Dispatch New Job</h2>
        <div><label class="block text-xs text-slate-400 mb-1">Queue</label><select id="queueSelect" class="w-full bg-slate-950 border border-slate-700 rounded p-2 text-xs"></select></div>
        <div><label class="block text-xs text-slate-400 mb-1">Payload (JSON)</label><textarea id="jobPayload" rows="2" class="w-full bg-slate-950 border border-slate-700 rounded p-2 text-xs font-mono">{"task": "generate_report", "simulate_fail": false}</textarea></div>
        <div class="grid grid-cols-2 gap-2">
          <div><label class="block text-xs text-slate-400 mb-1">Delay (s)</label><input id="jobDelay" type="number" value="0" class="w-full bg-slate-950 border border-slate-700 rounded p-2 text-xs" /></div>
          <div><label class="block text-xs text-slate-400 mb-1">Priority</label><input id="jobPriority" type="number" value="1" class="w-full bg-slate-950 border border-slate-700 rounded p-2 text-xs" /></div>
        </div>
        <button onclick="submitJob()" class="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-2 rounded text-xs transition">Enqueue Job</button>
      </div>

      <div class="md:col-span-2 bg-slate-900 p-5 rounded border border-slate-800 space-y-3">
        <h2 class="text-sm font-semibold text-white">Registered Worker Fleet</h2>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs text-slate-300">
            <thead class="bg-slate-950 uppercase text-[10px] text-slate-400">
              <tr><th class="p-2">Worker ID</th><th class="p-2">Hostname</th><th class="p-2">PID</th><th class="p-2">Load/Cap</th><th class="p-2">Status</th></tr>
            </thead>
            <tbody id="workersTable" class="divide-y divide-slate-800 font-mono"></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Job Explorer -->
    <div class="bg-slate-900 p-5 rounded border border-slate-800 space-y-3">
      <div class="flex justify-between items-center">
        <h2 class="text-sm font-semibold text-white">Job Explorer & Execution History</h2>
        <div class="flex gap-2">
          <select id="filterStatus" onchange="loadData()" class="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs">
            <option value="">All Statuses</option>
            <option value="QUEUED">QUEUED</option>
            <option value="SCHEDULED">SCHEDULED</option>
            <option value="CLAIMED">CLAIMED</option>
            <option value="RUNNING">RUNNING</option>
            <option value="COMPLETED">COMPLETED</option>
            <option value="DEAD_LETTER">DEAD_LETTER</option>
          </select>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs text-slate-300">
          <thead class="bg-slate-950 uppercase text-[10px] text-slate-400">
            <tr><th class="p-2">Job ID</th><th class="p-2">Queue</th><th class="p-2">Type</th><th class="p-2">Status</th><th class="p-2">Retries</th><th class="p-2">Payload</th><th class="p-2">Action</th></tr>
          </thead>
          <tbody id="jobsTable" class="divide-y divide-slate-800 font-mono"></tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    function getHeaders() {
      const token = document.getElementById('authToken').value.trim();
      const h = { 'Content-Type': 'application/json' };
      if (token) {
        if (token.startsWith('pk_live_')) h['x-api-key'] = token;
        else h['Authorization'] = 'Bearer ' + token;
      }
      return h;
    }

    async function loadData() {
      const h = getHeaders();
      const statusFilter = document.getElementById('filterStatus').value;
      const statusQuery = statusFilter ? '&status=' + statusFilter : '';
      try {
        const [metricsRes, queuesRes, workersRes, jobsRes] = await Promise.all([
          fetch('/api/metrics', { headers: h }).then(r => r.json()),
          fetch('/api/queues', { headers: h }).then(r => r.json()),
          fetch('/api/workers', { headers: h }).then(r => r.json()),
          fetch('/api/jobs?limit=25' + statusQuery, { headers: h }).then(r => r.json())
        ]);

        if (metricsRes.active_workers !== undefined) {
          document.getElementById('statWorkers').innerText = metricsRes.active_workers;
          let c = 0, q = 0, r = 0, d = 0;
          (metricsRes.jobs || []).forEach(item => {
            if (item.status === 'COMPLETED') c += item.count;
            if (['QUEUED', 'SCHEDULED'].includes(item.status)) q += item.count;
            if (['CLAIMED', 'RUNNING'].includes(item.status)) r += item.count;
            if (item.status === 'DEAD_LETTER') d += item.count;
          });
          document.getElementById('statCompleted').innerText = c;
          document.getElementById('statQueued').innerText = q;
          document.getElementById('statRunning').innerText = r;
          document.getElementById('statDLQ').innerText = d;
        }

        const qSel = document.getElementById('queueSelect');
        if (Array.isArray(queuesRes)) {
          qSel.innerHTML = '';
          queuesRes.forEach(queue => {
            const opt = document.createElement('option');
            opt.value = queue.id;
            opt.innerText = queue.name + ' (Max ' + queue.concurrency_limit + ')';
            qSel.appendChild(opt);
          });
        }

        if (Array.isArray(workersRes)) {
          document.getElementById('workersTable').innerHTML = workersRes.map(w => \`
            <tr>
              <td class="p-2 text-indigo-400">\${w.id.slice(0,8)}...</td>
              <td class="p-2 text-slate-400 font-sans">\${w.hostname}</td>
              <td class="p-2">\${w.pid}</td>
              <td class="p-2">\${w.current_load}/\${w.concurrency}</td>
              <td class="p-2"><span class="px-2 py-0.5 rounded text-[10px] font-bold \${w.live_status === 'ONLINE' ? 'bg-emerald-950 text-emerald-300 border border-emerald-700' : 'bg-rose-950 text-rose-300 border border-rose-700'}">\${w.live_status}</span></td>
            </tr>
          \`).join('');
        }

        if (jobsRes && Array.isArray(jobsRes.data)) {
          document.getElementById('jobsTable').innerHTML = jobsRes.data.map(j => {
            let badge = 'bg-slate-800 text-slate-300';
            if (j.status === 'COMPLETED') badge = 'bg-emerald-950 text-emerald-300 border border-emerald-700';
            if (['RUNNING', 'CLAIMED'].includes(j.status)) badge = 'bg-amber-950 text-amber-300 border border-amber-700';
            if (j.status === 'DEAD_LETTER') badge = 'bg-rose-950 text-rose-300 border border-rose-700';

            let action = '';
            if (j.status === 'DEAD_LETTER') {
              action = \`<button onclick="retryJob('\${j.id}')" class="bg-rose-600 hover:bg-rose-500 text-white px-2 py-1 rounded text-[10px]">Retry DLQ</button>\`;
            }

            return \`
              <tr>
                <td class="p-2 text-indigo-400">\${j.id.slice(0,8)}...</td>
                <td class="p-2 font-sans">\${j.queue_name || 'N/A'}</td>
                <td class="p-2 text-[10px]">\${j.job_type}</td>
                <td class="p-2"><span class="px-2 py-0.5 rounded text-[10px] font-semibold \${badge}">\${j.status}</span></td>
                <td class="p-2">\${j.retry_count}/\${j.max_retries}</td>
                <td class="p-2 max-w-xs truncate text-slate-400">\${JSON.stringify(j.payload)}</td>
                <td class="p-2">\${action}</td>
              </tr>
            \`;
          }).join('');
        }
      } catch (err) {
        console.warn('Dashboard fetch warning:', err);
      }
    }

    async function submitJob() {
      const queue_id = document.getElementById('queueSelect').value;
      const delay = parseInt(document.getElementById('jobDelay').value) || 0;
      const priority = parseInt(document.getElementById('jobPriority').value) || 1;
      let payload = {};
      try { payload = JSON.parse(document.getElementById('jobPayload').value); }
      catch(e) { alert('Invalid JSON payload'); return; }

      await fetch('/api/jobs', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ queue_id, payload, delay_seconds: delay, priority })
      });
      loadData();
    }

    async function retryJob(jobId) {
      await fetch('/api/dlq/' + jobId + '/retry', { method: 'POST', headers: getHeaders() });
      loadData();
    }

    setInterval(loadData, 2000);
  </script>
</body>
</html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API Server running on http://localhost:${PORT}`));