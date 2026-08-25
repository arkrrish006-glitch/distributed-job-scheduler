import { pool } from '../db';
import { v4 as uuidv4 } from 'uuid';
import * as os from 'os';

export const WORKER_ID = uuidv4();
export const HOSTNAME = os.hostname();
export const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '4', 10);

let isShuttingDown = false;
let activeJobCount = 0;
let heartbeatTimer: NodeJS.Timeout | null = null;
let reaperTimer: NodeJS.Timeout | null = null;

export async function registerWorker() {
  await pool.query(
    `INSERT INTO workers (id, hostname, pid, status, concurrency, current_load)
     VALUES ($1, $2, $3, 'ONLINE', $4, 0)
     ON CONFLICT (id) DO UPDATE SET status = 'ONLINE', last_heartbeat = NOW()`,
    [WORKER_ID, HOSTNAME, process.pid, CONCURRENCY]
  );

  heartbeatTimer = setInterval(async () => {
    try {
      await pool.query(
        `UPDATE workers SET last_heartbeat = NOW(), current_load = $1 WHERE id = $2`,
        [activeJobCount, WORKER_ID]
      );
      await pool.query(
        `INSERT INTO worker_heartbeats (worker_id, cpu_usage, memory_usage, active_jobs)
         VALUES ($1, $2, $3, $4)`,
        [WORKER_ID, Math.min(100, Math.round(os.loadavg()[0] * 10)), Math.round((1 - os.freemem() / os.totalmem()) * 100), activeJobCount]
      );
    } catch (e) {
      console.error('[Worker] Heartbeat sync failed:', e);
    }
  }, 5000);

  // Crash Recovery Reaper (Runs every 10 seconds)
  reaperTimer = setInterval(recoverStaleJobs, 10000);
}

export async function recoverStaleJobs() {
  try {
    const staleWorkers = await pool.query(
      `UPDATE workers SET status = 'OFFLINE'
       WHERE last_heartbeat < NOW() - INTERVAL '30 seconds' AND status = 'ONLINE'
       RETURNING id`
    );

    if (staleWorkers.rows.length > 0) {
      const staleIds = staleWorkers.rows.map(w => w.id);
      const recovered = await pool.query(
        `UPDATE jobs
         SET status = 'QUEUED', claimed_by = NULL, updated_at = NOW()
         WHERE claimed_by = ANY($1::uuid[]) AND status IN ('CLAIMED', 'RUNNING')
         RETURNING id`,
        [staleIds]
      );

      for (const row of recovered.rows) {
        await pool.query(
          `INSERT INTO job_logs (job_id, level, message) VALUES ($1, 'WARN', 'Job recovered from crashed worker lease')`,
          [row.id]
        );
      }
      if (recovered.rows.length > 0) {
        console.log(`[Reaper] Safely recovered ${recovered.rows.length} orphaned jobs.`);
      }
    }
  } catch (err) {
    console.error('[Reaper] Recovery iteration error:', err);
  }
}

export async function claimNextJob(batchSize: number = 1) {
  if (isShuttingDown || batchSize <= 0) return [];

  // Atomic Job Claiming with Enforced Queue Concurrency Limits & Queue Pause Check
  const query = `
    WITH active_per_queue AS (
      SELECT queue_id, COUNT(*)::int AS running_count
      FROM jobs
      WHERE status IN ('CLAIMED', 'RUNNING')
      GROUP BY queue_id
    ),
    eligible_queues AS (
      SELECT q.id, q.priority, q.concurrency_limit,
             COALESCE(apq.running_count, 0) AS current_active
      FROM queues q
      LEFT JOIN active_per_queue apq ON q.id = apq.queue_id
      WHERE q.is_paused = FALSE
        AND COALESCE(apq.running_count, 0) < q.concurrency_limit
    ),
    claimable AS (
      SELECT j.id
      FROM jobs j
      JOIN eligible_queues eq ON j.queue_id = eq.id
      WHERE j.status IN ('QUEUED', 'SCHEDULED')
        AND j.scheduled_for <= NOW()
      ORDER BY j.priority DESC, j.created_at ASC
      FOR UPDATE OF j SKIP LOCKED
      LIMIT $1
    )
    UPDATE jobs
    SET status = 'CLAIMED', claimed_by = $2, updated_at = NOW()
    WHERE id IN (SELECT id FROM claimable)
    RETURNING *;
  `;

  const res = await pool.query(query, [batchSize, WORKER_ID]);
  return res.rows;
}

export function calculateRetryDelay(strategy: string, attempt: number, baseDelay: number, maxDelay: number): number {
  let delay = baseDelay;
  if (strategy === 'LINEAR') {
    delay = baseDelay * attempt;
  } else if (strategy === 'EXPONENTIAL') {
    delay = baseDelay * Math.pow(2, attempt);
  }
  // Add 10% jitter to eliminate thundering herd
  const jitter = delay * (Math.random() * 0.1);
  return Math.min(maxDelay, Math.round(delay + jitter));
}

export async function processJob(job: any) {
  activeJobCount++;
  const startTime = Date.now();
  let executionId: string | null = null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE jobs SET status = 'RUNNING', updated_at = NOW() WHERE id = $1`, [job.id]);
    
    const execRes = await client.query(
      `INSERT INTO job_executions (job_id, worker_id, attempt, status, started_at)
       VALUES ($1, $2, $3, 'RUNNING', NOW()) RETURNING id`,
      [job.id, WORKER_ID, job.retry_count + 1]
    );
    executionId = execRes.rows[0].id;

    await client.query(
      `INSERT INTO job_logs (job_id, execution_id, level, message)
       VALUES ($1, $2, 'INFO', 'Execution attempt started')`,
      [job.id, executionId]
    );
    await client.query('COMMIT');

    // Job Execution Simulation / Dispatch
    if (job.payload && job.payload.simulate_fail) {
      throw new Error(job.payload.error_reason || 'Simulated runtime exception');
    }
    await new Promise((resolve) => setTimeout(resolve, 600));

    // Execution Success
    const executionDuration = Date.now() - startTime;
    await client.query('BEGIN');
    await client.query(
      `UPDATE jobs SET status = 'COMPLETED', result = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify({ status: 'SUCCESS', processed_by: WORKER_ID, duration_ms: executionDuration }), job.id]
    );
    await client.query(
      `UPDATE job_executions 
       SET status = 'COMPLETED', finished_at = NOW(), execution_time_ms = $1 
       WHERE id = $2`,
      [executionDuration, executionId]
    );
    await client.query(
      `INSERT INTO job_logs (job_id, execution_id, level, message)
       VALUES ($1, $2, 'INFO', 'Job completed successfully')`,
      [job.id, executionId]
    );
    await client.query('COMMIT');
  } catch (err: any) {
    await client.query('ROLLBACK');
    const executionDuration = Date.now() - startTime;
    const nextAttempt = job.retry_count + 1;
    const maxRetries = job.max_retries || 3;

    // Fetch queue retry policy
    const policyRes = await pool.query(
      `SELECT rp.* FROM queues q
       LEFT JOIN retry_policies rp ON q.retry_policy_id = rp.id
       WHERE q.id = $1`,
      [job.queue_id]
    );
    const policy = policyRes.rows[0] || { strategy: 'EXPONENTIAL', base_delay_seconds: 5, max_delay_seconds: 300 };

    if (nextAttempt >= maxRetries) {
      // Move to Dead Letter Queue (DLQ)
      await client.query('BEGIN');
      await client.query(`UPDATE jobs SET status = 'DEAD_LETTER', updated_at = NOW() WHERE id = $1`, [job.id]);
      await client.query(
        `INSERT INTO job_executions (job_id, worker_id, attempt, status, finished_at, error_message, execution_time_ms)
         VALUES ($1, $2, $3, 'DEAD_LETTER', NOW(), $4, $5)`,
        [job.id, WORKER_ID, nextAttempt, err.message, executionDuration]
      );
      await client.query(
        `INSERT INTO dead_letter_queue (job_id, queue_id, total_retries, last_error, original_payload)
         VALUES ($1, $2, $3, $4, $5)`,
        [job.id, job.queue_id, nextAttempt, err.message, job.payload]
      );
      await client.query(
        `INSERT INTO job_logs (job_id, level, message)
         VALUES ($1, 'ERROR', $2)`,
        [job.id, `Max retries reached (${maxRetries}). Moved to Dead Letter Queue.`]
      );
      await client.query('COMMIT');
    } else {
      // Re-schedule with backoff
      const delay = calculateRetryDelay(policy.strategy, nextAttempt, policy.base_delay_seconds, policy.max_delay_seconds);
      await client.query('BEGIN');
      await client.query(
        `UPDATE jobs
         SET status = 'QUEUED', retry_count = $1, scheduled_for = NOW() + ($2 || ' seconds')::INTERVAL, updated_at = NOW()
         WHERE id = $3`,
        [nextAttempt, delay, job.id]
      );
      await client.query(
        `INSERT INTO job_executions (job_id, worker_id, attempt, status, finished_at, error_message, execution_time_ms)
         VALUES ($1, $2, $3, 'FAILED', NOW(), $4, $5)`,
        [job.id, WORKER_ID, nextAttempt, err.message, executionDuration]
      );
      await client.query(
        `INSERT INTO job_logs (job_id, level, message)
         VALUES ($1, 'WARN', $2)`,
        [job.id, `Attempt ${nextAttempt} failed: ${err.message}. Retrying in ${delay}s (${policy.strategy}).`]
      );
      await client.query('COMMIT');
    }
  } finally {
    client.release();
    activeJobCount--;
  }
}

export async function startWorker() {
  await registerWorker();
  console.log(`🚀 [Worker Engine] Active: ${WORKER_ID} | Concurrency: ${CONCURRENCY}`);

  const activePromises = new Set<Promise<void>>();

  while (!isShuttingDown) {
    const availableSlots = CONCURRENCY - activeJobCount;
    if (availableSlots > 0) {
      const jobs = await claimNextJob(availableSlots);
      for (const job of jobs) {
        const jobPromise = processJob(job).finally(() => activePromises.delete(jobPromise));
        activePromises.add(jobPromise);
      }
    }
    await new Promise((r) => setTimeout(r, 800));
  }

  // Graceful Shutdown Drain
  console.log(`🛑 [Worker Engine] Draining ${activePromises.size} active jobs...`);
  await Promise.all(Array.from(activePromises));
  await pool.query(`UPDATE workers SET status = 'OFFLINE', last_heartbeat = NOW() WHERE id = $1`, [WORKER_ID]);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (reaperTimer) clearInterval(reaperTimer);
  console.log(`👋 [Worker Engine] Clean shutdown finished.`);
}

// Intercept System Signals for Graceful Shutdown
['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.on(signal, async () => {
    if (isShuttingDown) return;
    console.log(`\n⚠️ Received ${signal}. Initiating graceful shutdown sequence...`);
    isShuttingDown = true;
  });
});

if (require.main === module) {
  startWorker().catch(console.error);
}