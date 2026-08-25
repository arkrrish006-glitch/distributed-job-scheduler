# ⚡ Distributed Job Scheduler Platform

A production-ready distributed job scheduling and asynchronous execution engine built with **Node.js (TypeScript)** and **PostgreSQL**. Features atomic job claiming, concurrency isolation, heartbeat monitoring, exponential backoff retries, Dead Letter Queue (DLQ) isolation, and a real-time web dashboard.

---

## 🏛️ System Architecture

\`\`\`mermaid
graph TD
    Client[Web UI / REST API / SDK] -->|1. Enqueue Job| API[Express API Gateway]
    API -->|2. Persist State| Postgres[(PostgreSQL Primary)]
    
    subgraph "Distributed Worker Engine"
        W1[Worker Node 1] -->|Polls SKIP LOCKED| Postgres
        W2[Worker Node 2] -->|Polls SKIP LOCKED| Postgres
        W3[Worker Node 3] -->|Polls SKIP LOCKED| Postgres
        
        W1 -->|Heartbeats every 5s| Postgres
        W2 -->|Heartbeats every 5s| Postgres
        W3 -->|Heartbeats every 5s| Postgres
    end

    subgraph "Reliability & DLQ Pipeline"
        W1 -->|Max Retries Exceeded| DLQ[(Dead Letter Queue)]
        API -->|Re-queue Job| DLQ
    end
\`\`\`

---

## 📊 Entity Relationship (ER) Diagram

\`\`\`mermaid
erDiagram
    ORGANIZATIONS ||--o{ PROJECTS : owns
    PROJECTS ||--o{ QUEUES : contains
    RETRY_POLICIES ||--o{ QUEUES : configures
    QUEUES ||--o{ JOBS : holds
    QUEUES ||--o{ SCHEDULED_JOBS : schedules
    JOBS ||--o{ JOB_EXECUTIONS : records
    JOBS ||--o{ JOB_LOGS : emits
    JOBS ||--o| DEAD_LETTER_QUEUE : routes_to
    WORKERS ||--o{ WORKER_HEARTBEATS : emits
    WORKERS ||--o{ JOB_EXECUTIONS : executes
\`\`\`

---

## ⚙️ Core Technical Features & Design Decisions

### 1. Atomic Job Claiming Without Race Conditions
* **Mechanism:** Implements PostgreSQL's row-level locking via \`SELECT ... FOR UPDATE SKIP LOCKED\`.
* **Trade-off:** Avoids the multi-system sync penalty and cache invalidation risks of using external brokers (e.g., Redis/RabbitMQ) alongside a database, maintaining strict ACID guarantees with zero duplicate processing.

### 2. Job Lifecycle State Machine
* \`QUEUED\` ➔ \`CLAIMED\` ➔ \`RUNNING\` ➔ \`COMPLETED\` / \`FAILED\` ➔ \`DEAD_LETTER\`
* Immediate jobs enter as \`QUEUED\`. Delayed jobs enter as \`SCHEDULED\` with a future timestamp (\`scheduled_for\`).

### 3. Configurable Retry & Backoff Strategy
* **Exponential Backoff Formula:** 
  $$\Delta t = \min(\text{max\_delay}, \text{base\_delay} \times 2^{\text{attempt}})$$
* Prevents thundering herd problems on downstream services during intermittent outages.

### 4. Fault Detection & Worker Heartbeats
* Workers send lightweight heartbeats every 5 seconds to the \`workers\` table.
* Stalled or orphaned jobs from dead workers are safely identified when \`last_heartbeat < NOW() - INTERVAL '30 seconds'\`.

---

## 🚀 Setup & Execution Guide

### Prerequisites
* Node.js (v18+)
* PostgreSQL Database URL (Neon or Local)

### Installation
\`\`\`bash
git clone <your-repo-url>
cd job-scheduler
npm install
\`\`\`

### Environment Configuration
Create a \`.env\` file in the root directory:
\`\`\`env
PORT=3000
DATABASE_URL=postgresql://<user>:<password>@<host>/<database>?sslmode=require
\`\`\`

### Database Initialization
Run \`schema.sql\` in your PostgreSQL query editor.

### Running the Services
1. **Start the API Server & Web UI:**
   \`\`\`bash
   npx tsx src/api/server.ts
   \`\`\`
2. **Start the Distributed Worker Node:**
   \`\`\`bash
   npx tsx src/worker/worker.ts
   \`\`\`
3. **Open Dashboard:** Navigate to \`http://localhost:3000\`

---

## 🧪 Automated Testing
Run the concurrency and DLQ validation suite:
\`\`\`bash
npx tsx src/test.ts
\`\`\`

---

## 📡 REST API Reference

| Method | Endpoint | Description |
|---|---|---|
| \`GET\` | \`/api/queues\` | List all active queues |
| \`POST\` | \`/api/queues\` | Create a new queue |
| \`GET\` | \`/api/jobs\` | Fetch job history and execution states |
| \`POST\` | \`/api/jobs\` | Submit an immediate or delayed job |
| \`GET\` | \`/api/workers\` | Monitor real-time worker health |
| \`GET\` | \`/api/metrics\` | Aggregated throughput and failure metrics |
| \`POST\` | \`/api/dlq/:job_id/retry\` | Re-queue a failed DLQ job |