import { pool } from '../db';
import { v4 as uuidv4 } from 'uuid';

const WORKER_ID = uuidv4();
const HOSTNAME = 'worker-node-1';
const CONCURRENCY = 2;

async function registerWorker() {
  await pool.query(
    `INSERT INTO workers (id, hostname, pid, status, concurrency) 
     VALUES ($1, $2, $3, 'ONLINE', $4)
     ON CONFLICT (id) DO UPDATE SET status = 'ONLINE', last_heartbeat = NOW()`,
    [WORKER_ID, HOSTNAME, process.pid, CONCURRENCY]
  );

  setInterval(async () => {
    await pool.query(
      `UPDATE workers SET last_heartbeat = NOW() WHERE id = $1`,
      [WORKER_ID]
    );
  }, 5000);
}

async function claimNextJob() {
  const query = `
    WITH claimable AS (
      SELECT j.id
      FROM jobs j
      JOIN queues q ON j.queue_id = q.id
      WHERE j.status IN ('QUEUED', 'SCHEDULED')
        AND j.scheduled_for <= NOW()
        AND q.is_paused = FALSE
      ORDER BY j.priority DESC, j.created_at ASC
      FOR UPDATE OF j SKIP LOCKED
      LIMIT 1
    )
    UPDATE jobs
    SET status = 'CLAIMED', claimed_by = $1, updated_at = NOW()
    WHERE id IN (SELECT id FROM claimable)
    RETURNING *;
  `;
  const res = await pool.query(query, [WORKER_ID]);
  return res.rows[0] || null;
}

async function processJob(job: any) {
  const startTime = Date.now();
  await pool.query(`UPDATE jobs SET status = 'RUNNING', updated_at = NOW() WHERE id = $1`, [job.id]);

  try {
    console.log(`[Worker ${WORKER_ID}] Executing Job ${job.id}...`);
    // Simulated work
    await new Promise((resolve) => setTimeout(resolve, 1000));

    await pool.query(
      `UPDATE jobs SET status = 'COMPLETED', updated_at = NOW(), result = $1 WHERE id = $2`,
      [JSON.stringify({ status: 'done', processed_at: new Date() }), job.id]
    );

    await pool.query(
      `INSERT INTO job_executions (job_id, worker_id, attempt, status, execution_time_ms) 
       VALUES ($1, $2, $3, 'COMPLETED', $4)`,
      [job.id, WORKER_ID, job.retry_count + 1, Date.now() - startTime]
    );
    console.log(`[Worker ${WORKER_ID}] Completed Job ${job.id}`);
  } catch (err: any) {
    const nextRetry = job.retry_count + 1;
    const maxRetries = job.max_retries || 3;

    if (nextRetry >= maxRetries) {
      await pool.query(`UPDATE jobs SET status = 'DEAD_LETTER', updated_at = NOW() WHERE id = $1`, [job.id]);
      await pool.query(
        `INSERT INTO dead_letter_queue (job_id, queue_id, total_retries, last_error, original_payload)
         VALUES ($1, $2, $3, $4, $5)`,
        [job.id, job.queue_id, nextRetry, err.message, job.payload]
      );
    } else {
      const delaySeconds = Math.min(300, 5 * Math.pow(2, nextRetry));
      await pool.query(
        `UPDATE jobs 
         SET status = 'QUEUED', retry_count = $1, scheduled_for = NOW() + ($2 || ' seconds')::INTERVAL, updated_at = NOW() 
         WHERE id = $3`,
        [nextRetry, delaySeconds, job.id]
      );
    }
  }
}

export async function startWorker() {
  await registerWorker();
  console.log(` Worker active: ${WORKER_ID}`);

  while (true) {
    const job = await claimNextJob();
    if (job) {
      await processJob(job);
    } else {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

startWorker().catch(console.error);