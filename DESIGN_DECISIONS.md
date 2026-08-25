# ⚙️ Technical Design Decisions & Trade-offs

### 1. PostgreSQL SKIP LOCKED vs. External Message Broker
* **Decision:** Use PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED`.
* **Trade-off:** Avoids multi-system distributed state sync between Redis/RabbitMQ and a SQL database. Maintains strict ACID transactional boundaries during state updates and DLQ routing.

### 2. Multi-Tenant Scoping at SQL Layer
* **Decision:** Enforce `WHERE projects.org_id = req.user.org_id` on all queue and job operations.
* **Trade-off:** Prevents cross-tenant access even if internal UUIDs are known.

### 3. Jittered Exponential Backoff
* **Formula:** $\Delta t = \min(\text{max\_delay}, \text{base\_delay} \times 2^{\text{attempt}}) + \text{jitter}$
* **Trade-off:** Introduces 10% random jitter to eliminate thundering-herd spikes on downstream dependencies.

### 4. Dual-Mode Authentication (JWT & Secure API Key)
* **Decision:** Support both browser JWT sessions and cryptographic `x-api-key` headers.
* **Trade-off:** Allows dashboard users to log in securely while microservices can dispatch jobs directly via API keys.