import { pool } from '../db';
const cronParser = require('cron-parser');

export async function runCronSchedulerIteration() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dueJobs = await client.query(
      `SELECT * FROM scheduled_jobs
       WHERE is_active = TRUE AND next_run_at <= NOW()
       FOR UPDATE SKIP LOCKED
       LIMIT 10`
    );

    for (const item of dueJobs.rows) {
      await client.query(
        `INSERT INTO jobs (queue_id, job_type, payload, status, scheduled_for)
         VALUES ($1, 'RECURRING', $2, 'QUEUED', NOW())`,
        [item.queue_id, item.payload]
      );

      const interval = cronParser.parseExpression(item.cron_expression);
      const nextDate = interval.next().toDate();

      await client.query(
        `UPDATE scheduled_jobs
         SET last_run_at = NOW(), next_run_at = $1
         WHERE id = $2`,
        [nextDate, item.id]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Cron Scheduler] Iteration error:', err);
  } finally {
    client.release();
  }
}

export function startCronService(intervalMs = 5000) {
  setInterval(runCronSchedulerIteration, intervalMs);
}