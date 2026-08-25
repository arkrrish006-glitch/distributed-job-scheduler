# 📡 REST API Reference

All protected endpoints require authentication via one of two mechanisms:
* **JWT Session Token:** `Authorization: Bearer <JWT_TOKEN>`
* **Project API Key:** `x-api-key: <PROJECT_API_KEY>`

All queue and job queries enforce strict organization-level multi-tenant isolation (`WHERE projects.org_id = req.user.org_id`).

---

## Complete Endpoints Specification

| Method | Endpoint | Auth | RBAC Role | Description |
|---|---|---|---|---|
| `POST` | `/api/auth/register` | Public | None | Register an organization and create an initial admin user. Returns JWT and user payload. |
| `POST` | `/api/auth/login` | Public | None | Authenticate user credentials and receive a JWT access token. |
| `GET` | `/api/auth/me` | Bearer | Any | Retrieve the authenticated user context and organization ID. |
| `POST` | `/api/projects` | Bearer | Any | Create a project within the authenticated organization with a cryptographic API key. |
| `GET` | `/api/projects` | Bearer | Any | List all projects belonging to the authenticated organization. |
| `GET` | `/api/projects/:id` | Bearer | Any | Retrieve metadata for a specific project owned by the organization. |
| `GET` | `/api/queues` | Bearer / API Key | Any | List all active queues owned by the organization's projects. |
| `POST` | `/api/queues` | Bearer / API Key | Any | Create a new queue with defined priority, concurrency limit, and retry policy. |
| `PATCH` | `/api/queues/:id` | Bearer / API Key | `ADMIN` / `SERVICE` | Update queue settings (pause/resume, concurrency limit, priority). |
| `GET` | `/api/queues/:id/stats` | Bearer / API Key | Any | Fetch queue execution metrics (queued, running, completed, DLQ count). |
| `POST` | `/api/jobs` | Bearer / API Key | Any | Enqueue an immediate or delayed job (supports `Idempotency-Key` header). |
| `POST` | `/api/jobs/batch` | Bearer / API Key | Any | Atomically ingest an array of jobs within a single database transaction. |
| `POST` | `/api/scheduled-jobs` | Bearer / API Key | Any | Create a recurring cron job with automatic next-run timestamp calculation. |
| `GET` | `/api/jobs` | Bearer / API Key | Any | Retrieve paginated job history with status/queue filtering (`?page=1&limit=20&status=...`). |
| `GET` | `/api/workers` | Bearer / API Key | Any | Monitor real-time worker fleet health, heartbeat intervals, and load capacity. |
| `GET` | `/api/metrics` | Bearer / API Key | Any | Aggregated job execution stats and active worker counts for the organization. |
| `POST` | `/api/dlq/:job_id/retry` | Bearer / API Key | `ADMIN` / `SERVICE` | Manually re-queue a dead-lettered job back into `QUEUED` state. |