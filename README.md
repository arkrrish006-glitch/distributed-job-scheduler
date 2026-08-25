# ⚡ Distributed Job Scheduler Platform

A production-ready distributed job scheduling and asynchronous execution engine built with **Node.js (TypeScript)** and **PostgreSQL**. Features atomic job claiming (`FOR UPDATE SKIP LOCKED`), concurrency isolation, worker heartbeats, exponential backoff retries, Dead Letter Queue (DLQ) routing, multi-tenant organization scoping, and a real-time web dashboard.

---

## 📑 Core Documentation Deliverables

* 🏛️ [System Architecture](ARCHITECTURE.md)
* 📊 [Entity Relationship & Indexing Model](ER_DIAGRAM.md)
* 📡 [Complete REST API Specification](API_DOCS.md)
* ⚙️ [Design Decisions & Trade-offs](DESIGN_DECISIONS.md)

---

## 🚀 Quick Setup Guide

### 1. Prerequisites
* **Node.js**: v18.0.0 or higher
* **PostgreSQL**: Neon Cloud PostgreSQL or a local PostgreSQL instance (v14+)

---

### 2. Install Dependencies
Clone the repository and install all dependencies:

```bash
git clone [https://github.com/arkrrish006-glitch/distributed-job-scheduler.git](https://github.com/arkrrish006-glitch/distributed-job-scheduler.git)
cd distributed-job-scheduler
npm install
```

---

### 3. Environment Configuration
Create a `.env` file in the root directory based on the `.env.example` template:

```bash
cp .env.example .env
```

Ensure the following three environment variables are configured in `.env`:

```env
PORT=3000
DATABASE_URL=postgresql://<user>:<password>@<host>/<database>?sslmode=require
JWT_SECRET=replace_with_a_secure_random_secret_key_min_32_chars
```

> **Mandatory Variable Warning**: `JWT_SECRET` is strictly required. The application implements a fail-fast startup check in `src/api/auth.ts` and will throw a fatal error and refuse to boot if `JWT_SECRET` is not set.

---

### 4. Database Initialization
Run the complete relational DDL schema against your PostgreSQL instance using the `schema.sql` script:

```bash
# Using PostgreSQL CLI:
psql "<DATABASE_URL>" -f schema.sql

# Or copy and execute the contents of schema.sql inside your Neon SQL Editor console.
```

---

### 5. Running the Services
The application requires running the API server and the distributed worker engine across two separate terminal sessions:

**Terminal 1 — API Server & Web Dashboard:**
```bash
npm run start:api
```

**Terminal 2 — Distributed Worker Node:**
```bash
npm run start:worker
```

---

### 6. Opening the Dashboard & Authentication
Navigate to the web dashboard in your browser:
👉 **[http://localhost:3000](http://localhost:3000)**

#### Authenticating the Dashboard:
All queue and job queries enforce organization-level tenant scoping (`WHERE projects.org_id = req.user.org_id`). To view and dispatch jobs:
1. Register an organization and admin user via `POST /api/auth/register` (or log in via `POST /api/auth/login`):
   ```bash
   curl -X POST http://localhost:3000/api/auth/register \
     -H "Content-Type: application/json" \
     -d '{"org_name": "My Org", "email": "admin@example.com", "password": "password123"}'
   ```
2. Copy the returned `token` from the JSON response.
3. Paste the token into the **"Paste Bearer Token or x-api-key"** input box located at the top-right of the dashboard and click **Authorize**.
4. The dashboard will automatically poll every 2 seconds and display live worker nodes, queues, throughput counters, and execution history.

*(You can also use a project API key starting with `pk_live_` in the same authorize box).*

---

### 7. Running Tests
Execute the automated concurrency isolation, queue limit gating, worker crash recovery, backoff delay calculations, and DLQ test suite:

```bash
npm test
```