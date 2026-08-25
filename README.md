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
Clone the repository and install the production and development dependencies:

```bash
git clone [https://github.com/arkrrish006-glitch/distributed-job-scheduler.git](https://github.com/arkrrish006-glitch/distributed-job-scheduler.git)
cd distributed-job-scheduler
npm install