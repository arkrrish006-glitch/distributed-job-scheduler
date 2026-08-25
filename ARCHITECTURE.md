# 🏛️ System Architecture

```mermaid
graph TD
    Client[Web UI / REST API / SDK] -->|1. JWT / x-api-key Auth| Gateway[Express API Gateway & Rate Limiter]
    Gateway -->|2. Multi-Tenant Scoped Queries| DB[(PostgreSQL Primary Source of Truth)]

    subgraph "Distributed Worker Engine"
        W1[Worker Node 1] -->|Polls FOR UPDATE SKIP LOCKED| DB
        W2[Worker Node 2] -->|Polls FOR UPDATE SKIP LOCKED| DB
        W3[Worker Node 3] -->|Polls FOR UPDATE SKIP LOCKED| DB
        
        W1 -->|Heartbeats every 5s| DB
        W2 -->|Heartbeats every 5s| DB
        W3 -->|Heartbeats every 5s| DB
    end

    subgraph "Reliability & Recovery Pipeline"
        Reaper[Reaper Service] -->|Detects heartbeat > 30s| DB
        Reaper -->|Safely resets orphaned jobs to QUEUED| DB
        W1 -->|Max Retries Exceeded| DLQ[(Dead Letter Queue)]
        Gateway -->|Re-queue Job /api/dlq/:id/retry| DLQ
    end

    subgraph "Scheduling Subsystem"
        Cron[Cron Parser Daemon] -->|next_run_at <= NOW| DB
        Cron -->|Dispatches RECURRING job instance| DB
    end