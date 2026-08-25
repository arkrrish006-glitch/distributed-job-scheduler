# 📊 Database Entity Relationship & Indexing Model

```mermaid
erDiagram
    ORGANIZATIONS ||--o{ USERS : contains
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