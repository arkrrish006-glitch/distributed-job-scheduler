#### 3. `API_DOCS.md`
```markdown
# 📡 REST API Reference

All requests must provide an authorization header:
* `Authorization: Bearer <JWT>`
* `x-api-key: <PROJECT_API_KEY>`

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/api/auth/register` | Public | Register organization and admin user |
| `POST` | `/api/auth/login` | Public | Login and receive JWT access token |
| `GET` | `/api/auth/me` | Bearer | Fetch authenticated user context |
| `POST` | `/api/projects` | Bearer | Create a new project with crypto API key |
| `GET` | `/api/projects` | Bearer | List organization projects |
| `GET` | `/api/projects/:id` | Bearer | Get project details by ID |
| `GET` | `/api/queues` | Bearer/API Key | List organization queues |
| `POST` | `/api/queues` | Bearer/API Key | Create queue with priority and limits |
| `PATCH` | `/api/queues/:id` | ADMIN / Svc | Update queue (pause/resume, limit, priority) |
| `GET` | `/api/queues/:id/stats` | Bearer/API Key | Fetch queue execution metrics and DLQ count |
| `POST` | `/api/jobs` | Bearer/API Key | Submit immediate or delayed job (supports `Idempotency-Key`) |
| `POST` | `/api/jobs/batch` | Bearer/API Key | Atomic transactional batch job submission |
| `POST` | `/api/scheduled-jobs` | Bearer/API Key | Schedule recurring cron task |
| `GET` | `/api/jobs` | Bearer/API Key | Paginated job list (`?page=1&limit=20&status=...`) |
| `GET` | `/api/workers` | Bearer/API Key | Infrastructure worker fleet status |
| `GET` | `/api/metrics` | Bearer/API Key | Organization throughput and worker counts |
| `POST` | `/api/dlq/:job_id/retry` | ADMIN / Svc | Re-queue failed DLQ job |