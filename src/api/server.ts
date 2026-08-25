import express from 'express';
import cors from 'cors';
import { pool } from '../db';

const app = express();
app.use(cors());
app.use(express.json());

// --- API Endpoints ---

// 1. Get Queues
app.get('/api/queues', async (_req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM queues ORDER BY created_at DESC`);
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Create Queue
app.post('/api/queues', async (req, res) => {
  const { project_id, name, priority, concurrency_limit } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO queues (project_id, name, priority, concurrency_limit) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [project_id, name, priority || 1, concurrency_limit || 10]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// 3. Get All Jobs with Logs
app.get('/api/jobs', async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT j.*, q.name as queue_name 
       FROM jobs j 
       LEFT JOIN queues q ON j.queue_id = q.id 
       ORDER BY j.created_at DESC LIMIT 50`
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Enqueue Job
app.post('/api/jobs', async (req, res) => {
  const { queue_id, job_type, payload, priority, delay_seconds } = req.body;
  try {
    const scheduledFor = delay_seconds
      ? new Date(Date.now() + delay_seconds * 1000)
      : new Date();

    const result = await pool.query(
      `INSERT INTO jobs (queue_id, job_type, payload, priority, scheduled_for, status)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [queue_id, job_type || 'IMMEDIATE', payload, priority || 1, scheduledFor, delay_seconds ? 'SCHEDULED' : 'QUEUED']
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// 5. Get Workers Status
app.get('/api/workers', async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT *, 
       CASE 
         WHEN last_heartbeat > NOW() - INTERVAL '15 seconds' THEN 'ONLINE' 
         ELSE 'OFFLINE' 
       END as live_status 
       FROM workers ORDER BY last_heartbeat DESC`
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Metrics Summary
app.get('/api/metrics', async (_req, res) => {
  try {
    const jobStats = await pool.query(`SELECT status, COUNT(*)::int as count FROM jobs GROUP BY status`);
    const workerStats = await pool.query(`SELECT COUNT(*)::int as active_workers FROM workers WHERE last_heartbeat > NOW() - INTERVAL '15 seconds'`);
    res.json({
      jobs: jobStats.rows,
      active_workers: workerStats.rows[0]?.active_workers || 0
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Embedded Web UI Dashboard
app.get('/', (_req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Distributed Job Scheduler Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-100 font-sans p-8">
  <div class="max-w-7xl mx-auto space-y-8">
    <div class="flex justify-between items-center border-b border-slate-800 pb-4">
      <div>
        <h1 class="text-3xl font-bold tracking-tight text-white">⚡ Job Scheduler Dashboard</h1>
        <p class="text-slate-400">Real-time distributed queue & worker monitor</p>
      </div>
      <div id="liveBadge" class="flex items-center gap-2 bg-emerald-950 border border-emerald-700 px-3 py-1 rounded-full text-emerald-300 text-xs font-semibold">
        <span class="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span> Live Polling
      </div>
    </div>

    <!-- Quick Metrics -->
    <div class="grid grid-cols-1 md:grid-cols-4 gap-4" id="metricsGrid">
      <div class="bg-slate-800 p-5 rounded-lg border border-slate-700">
        <p class="text-slate-400 text-xs uppercase font-medium">Active Workers</p>
        <p id="statWorkers" class="text-3xl font-bold mt-1 text-white">0</p>
      </div>
      <div class="bg-slate-800 p-5 rounded-lg border border-slate-700">
        <p class="text-slate-400 text-xs uppercase font-medium">Completed Jobs</p>
        <p id="statCompleted" class="text-3xl font-bold mt-1 text-emerald-400">0</p>
      </div>
      <div class="bg-slate-800 p-5 rounded-lg border border-slate-700">
        <p class="text-slate-400 text-xs uppercase font-medium">Queued / Running</p>
        <p id="statActive" class="text-3xl font-bold mt-1 text-amber-400">0</p>
      </div>
      <div class="bg-slate-800 p-5 rounded-lg border border-slate-700">
        <p class="text-slate-400 text-xs uppercase font-medium">Dead Letter (DLQ)</p>
        <p id="statDLQ" class="text-3xl font-bold mt-1 text-rose-400">0</p>
      </div>
    </div>

    <!-- Workers & Form Section -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
      <div class="md:col-span-1 bg-slate-800 p-6 rounded-lg border border-slate-700 space-y-4">
        <h2 class="text-lg font-semibold text-white">Enqueue New Job</h2>
        <div>
          <label class="block text-xs font-medium text-slate-400 mb-1">Queue</label>
          <select id="queueSelect" class="w-full bg-slate-900 border border-slate-700 rounded p-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"></select>
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-400 mb-1">Payload (JSON)</label>
          <textarea id="jobPayload" rows="3" class="w-full bg-slate-900 border border-slate-700 rounded p-2 text-sm text-slate-200 font-mono focus:outline-none focus:border-indigo-500">{"action": "process_video", "quality": "1080p"}</textarea>
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-400 mb-1">Delay (seconds, 0 for immediate)</label>
          <input id="jobDelay" type="number" value="0" class="w-full bg-slate-900 border border-slate-700 rounded p-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500" />
        </div>
        <button onclick="submitJob()" class="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-2 rounded transition">Submit Job</button>
      </div>

      <div class="md:col-span-2 bg-slate-800 p-6 rounded-lg border border-slate-700 space-y-4">
        <h2 class="text-lg font-semibold text-white">Registered Worker Nodes</h2>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm text-slate-300">
            <thead class="bg-slate-900/50 uppercase text-xs text-slate-400">
              <tr>
                <th class="p-3">Worker ID</th>
                <th class="p-3">Hostname</th>
                <th class="p-3">PID</th>
                <th class="p-3">Concurrency</th>
                <th class="p-3">Status</th>
              </tr>
            </thead>
            <tbody id="workersTable" class="divide-y divide-slate-700 font-mono text-xs"></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Jobs Explorer -->
    <div class="bg-slate-800 p-6 rounded-lg border border-slate-700 space-y-4">
      <h2 class="text-lg font-semibold text-white">Job Explorer & Execution History</h2>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm text-slate-300">
          <thead class="bg-slate-900/50 uppercase text-xs text-slate-400">
            <tr>
              <th class="p-3">Job ID</th>
              <th class="p-3">Queue</th>
              <th class="p-3">Type</th>
              <th class="p-3">Status</th>
              <th class="p-3">Retries</th>
              <th class="p-3">Payload</th>
              <th class="p-3">Created At</th>
            </tr>
          </thead>
          <tbody id="jobsTable" class="divide-y divide-slate-700 text-xs"></tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    async function loadData() {
      try {
        const [metricsRes, queuesRes, workersRes, jobsRes] = await Promise.all([
          fetch('/api/metrics').then(r => r.json()),
          fetch('/api/queues').then(r => r.json()),
          fetch('/api/workers').then(r => r.json()),
          fetch('/api/jobs').then(r => r.json())
        ]);

        // Metrics
        document.getElementById('statWorkers').innerText = metricsRes.active_workers;
        let completed = 0, active = 0, dlq = 0;
        metricsRes.jobs.forEach(j => {
          if (j.status === 'COMPLETED') completed += j.count;
          else if (['QUEUED', 'RUNNING', 'CLAIMED', 'SCHEDULED'].includes(j.status)) active += j.count;
          else if (j.status === 'DEAD_LETTER') dlq += j.count;
        });
        document.getElementById('statCompleted').innerText = completed;
        document.getElementById('statActive').innerText = active;
        document.getElementById('statDLQ').innerText = dlq;

        // Queues dropdown
        const qSel = document.getElementById('queueSelect');
        if (qSel.children.length === 0) {
          queuesRes.forEach(q => {
            const opt = document.createElement('option');
            opt.value = q.id;
            opt.innerText = \`\${q.name} (\${q.id.slice(0,8)}...)\`;
            qSel.appendChild(opt);
          });
        }

        // Workers table
        const wBody = document.getElementById('workersTable');
        wBody.innerHTML = workersRes.map(w => \`
          <tr>
            <td class="p-3 font-semibold">\${w.id.slice(0,8)}...</td>
            <td class="p-3 text-slate-400">\${w.hostname}</td>
            <td class="p-3">\${w.pid}</td>
            <td class="p-3">\${w.concurrency}</td>
            <td class="p-3">
              <span class="px-2 py-1 rounded text-[10px] font-bold \${w.live_status === 'ONLINE' ? 'bg-emerald-900/60 text-emerald-300' : 'bg-rose-900/60 text-rose-300'}">
                \${w.live_status}
              </span>
            </td>
          </tr>
        \`).join('');

        // Jobs table
        const jBody = document.getElementById('jobsTable');
        jBody.innerHTML = jobsRes.map(j => {
          let badge = 'bg-slate-700 text-slate-300';
          if (j.status === 'COMPLETED') badge = 'bg-emerald-900/60 text-emerald-300';
          if (j.status === 'RUNNING' || j.status === 'CLAIMED') badge = 'bg-amber-900/60 text-amber-300';
          if (j.status === 'DEAD_LETTER') badge = 'bg-rose-900/60 text-rose-300';

          return \`
            <tr class="hover:bg-slate-800/50 font-mono">
              <td class="p-3 text-indigo-400 font-semibold">\${j.id.slice(0,8)}...</td>
              <td class="p-3 font-sans">\${j.queue_name || 'N/A'}</td>
              <td class="p-3 text-[11px]">\${j.job_type}</td>
              <td class="p-3"><span class="px-2 py-0.5 rounded text-[10px] font-bold \${badge}">\${j.status}</span></td>
              <td class="p-3">\${j.retry_count}/\${j.max_retries}</td>
              <td class="p-3 max-w-xs truncate text-slate-400">\${JSON.stringify(j.payload)}</td>
              <td class="p-3 text-slate-500 font-sans">\${new Date(j.created_at).toLocaleTimeString()}</td>
            </tr>
          \`;
        }).join('');
      } catch (e) {
        console.error("Polling error", e);
      }
    }

    async function submitJob() {
      const queue_id = document.getElementById('queueSelect').value;
      const delay = parseInt(document.getElementById('jobDelay').value) || 0;
      let payload = {};
      try {
        payload = JSON.parse(document.getElementById('jobPayload').value);
      } catch (err) {
        alert('Invalid JSON Payload');
        return;
      }

      await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          queue_id,
          payload,
          delay_seconds: delay,
          job_type: delay > 0 ? 'DELAYED' : 'IMMEDIATE'
        })
      });
      loadData();
    }

    loadData();
    setInterval(loadData, 2000);
  </script>
</body>
</html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));