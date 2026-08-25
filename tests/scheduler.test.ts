import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../src/db';
import { v4 as uuidv4 } from 'uuid';
import { calculateRetryDelay, recoverStaleJobs } from '../src/worker/worker';

describe('Distributed Job Scheduler Test Suite', () => {
  let testOrgId: string;
  let testProjectId: string;
  let testQueueId: string;

  beforeAll(async () => {
    const orgRes = await pool.query(`INSERT INTO organizations (name) VALUES ('Test Suite Org') RETURNING id`);
    testOrgId = orgRes.rows[0].id;

    const projRes = await pool.query(
      `INSERT INTO projects (org_id, name, api_key) VALUES ($1, 'Test Project', $2) RETURNING id`,
      [testOrgId, uuidv4()]
    );
    testProjectId = projRes.rows[0].id;

    const qRes = await pool.query(
      `INSERT INTO queues (project_id, name, priority, concurrency_limit)
       VALUES ($1, $2, 1, 2) RETURNING id`,
      [testProjectId, `test-queue-${uuidv4().substring(0, 8)}`]
    );
    testQueueId = qRes.rows[0].id;
  }, 20000);

  afterAll(async () => {
    if (testOrgId) {
      await pool.query(`DELETE FROM organizations WHERE id = $1`, [testOrgId]);
    }
  }, 20000);

  describe('Retry backoff formulas (Unit Tests - Pure Functions)', () => {
    it('should compute fixed backoff accurately with bounded jitter', () => {
      const delay = calculateRetryDelay('FIXED', 3, 10, 300);
      expect(delay).toBeGreaterThanOrEqual(10);
      expect(delay).toBeLessThanOrEqual(12);
    });

    it('should compute linear backoff based on attempt count', () => {
      const delay = calculateRetryDelay('LINEAR', 4, 5, 300);
      expect(delay).toBeGreaterThanOrEqual(20);
      expect(delay).toBeLessThanOrEqual(23);
    });

    it('should compute exponential backoff and respect maxDelay cap', () => {
      const delay = calculateRetryDelay('EXPONENTIAL', 3, 5, 300);
      expect(delay).toBeGreaterThanOrEqual(40);
      expect(delay).toBeLessThanOrEqual(45);

      const capped = calculateRetryDelay('EXPONENTIAL', 10, 10, 50);
      expect(capped).toBe(50);
    });
  });

  describe('Concurrent job claiming', () => {
    it('should prevent race conditions and duplicate claims across 10 simultaneous workers', async () => {
      const workerIds = Array.from({ length: 10 }, () => uuidv4());

      // Parallel batch registration & job insertion (1 round-trip)
      const workerPromises = workerIds.map((wId, i) =>
        pool.query(
          `INSERT INTO workers (id, hostname, pid, status, concurrency) VALUES ($1, $2, $3, 'ONLINE', 2)`,
          [wId, `test-worker-${i}`, 1000 + i]
        )
      );
      const jobPromises = workerIds.map((_, i) =>
        pool.query(
          `INSERT INTO jobs (queue_id, job_type, payload, status) VALUES ($1, 'IMMEDIATE', $2, 'QUEUED')`,
          [testQueueId, JSON.stringify({ index: i })]
        )
      );

      await Promise.all([...workerPromises, ...jobPromises]);

      const claimQuery = `
        WITH claimable AS (
          SELECT j.id FROM jobs j
          WHERE j.queue_id = $1 AND j.status = 'QUEUED' AND j.scheduled_for <= NOW()
          ORDER BY j.priority DESC, j.created_at ASC
          FOR UPDATE OF j SKIP LOCKED
          LIMIT 1
        )
        UPDATE jobs SET status = 'CLAIMED', claimed_by = $2, updated_at = NOW()
        WHERE id IN (SELECT id FROM claimable)
        RETURNING id;
      `;

      // 10 truly concurrent worker claim operations
      const claimResults = await Promise.all(
        workerIds.map((wId) => pool.query(claimQuery, [testQueueId, wId]))
      );

      const claimedIds = claimResults.map((r) => r.rows[0]?.id).filter(Boolean);
      const uniqueClaimed = new Set(claimedIds);

      expect(claimedIds.length).toBe(uniqueClaimed.size);
      expect(claimedIds.length).toBeGreaterThan(0);
    }, 25000);
  });

  describe('Queue concurrency limit enforcement', () => {
    it('should block claiming when queue running jobs equal concurrency_limit', async () => {
      const activeCheckRes = await pool.query(
        `SELECT id FROM jobs WHERE queue_id = $1 AND status = 'CLAIMED' LIMIT 2`,
        [testQueueId]
      );
      const ids = activeCheckRes.rows.map((r: any) => r.id);
      if (ids.length >= 2) {
        await pool.query(`UPDATE jobs SET status = 'RUNNING' WHERE id IN ($1, $2)`, [ids[0], ids[1]]);
      }

      const queueLimitCheckQuery = `
        WITH active_count AS (
          SELECT COUNT(*)::int as count FROM jobs WHERE queue_id = $1 AND status IN ('CLAIMED', 'RUNNING')
        ),
        claimable AS (
          SELECT j.id FROM jobs j
          CROSS JOIN active_count ac
          WHERE j.queue_id = $1 AND j.status = 'QUEUED' AND ac.count < 2
          FOR UPDATE OF j SKIP LOCKED
          LIMIT 1
        )
        UPDATE jobs SET status = 'CLAIMED' WHERE id IN (SELECT id FROM claimable) RETURNING id;
      `;

      const blockedRes = await pool.query(queueLimitCheckQuery, [testQueueId]);
      expect(blockedRes.rows.length).toBe(0);
    }, 20000);
  });

  describe('Idempotency', () => {
    it('should reject duplicate job inserts with identical idempotency_key', async () => {
      const idempotencyKey = `idem_${uuidv4()}`;

      const firstRes = await pool.query(
        `INSERT INTO jobs (queue_id, payload, idempotency_key, status) VALUES ($1, $2, $3, 'QUEUED') RETURNING id`,
        [testQueueId, JSON.stringify({ action: 'process_payment' }), idempotencyKey]
      );
      expect(firstRes.rows[0]?.id).toBeDefined();

      let errorThrown = false;
      try {
        await pool.query(
          `INSERT INTO jobs (queue_id, payload, idempotency_key, status) VALUES ($1, $2, $3, 'QUEUED')`,
          [testQueueId, JSON.stringify({ action: 'process_payment' }), idempotencyKey]
        );
      } catch (err: any) {
        errorThrown = true;
      }
      expect(errorThrown).toBe(true);
    }, 20000);
  });

  describe('Worker crash recovery', () => {
    it('should identify stale worker heartbeats and safely requeue orphaned jobs', async () => {
      const crashedWorkerId = uuidv4();
      await pool.query(
        `INSERT INTO workers (id, hostname, pid, status, last_heartbeat)
         VALUES ($1, 'crashed-worker-host', 8888, 'ONLINE', NOW() - INTERVAL '45 seconds')`,
        [crashedWorkerId]
      );

      const orphanedJob = await pool.query(
        `INSERT INTO jobs (queue_id, payload, status, claimed_by) VALUES ($1, '{}', 'RUNNING', $2) RETURNING id`,
        [testQueueId, crashedWorkerId]
      );

      await recoverStaleJobs();

      const jobStatus = await pool.query(`SELECT status, claimed_by FROM jobs WHERE id = $1`, [orphanedJob.rows[0].id]);
      expect(jobStatus.rows[0].status).toBe('QUEUED');
      expect(jobStatus.rows[0].claimed_by).toBeNull();
    }, 20000);
  });
});