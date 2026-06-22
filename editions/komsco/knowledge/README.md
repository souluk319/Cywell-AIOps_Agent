# KOMSCO Knowledge Pack v0.1.1

This directory documents the synthetic customer-data shape used by CAS v0.1.1.

The runnable corpus is kept under `apps/gateway/runbooks/komsco-ops-sim.jsonl`
so the Gateway image can include it without adding another build copy rule.

The data is intentionally synthetic. It models the kinds of operational
knowledge CAS needs before real customer onboarding:

- service profiles and dependency maps
- incident severity and read-only RCA policy
- workload runbooks
- known incident patterns
- metric interpretation guides
- evidence and redaction rules

Acceptance criteria:

- CAS retrieves at least one customer-specific runbook hit per simulation.
- The brain prompt includes a short runbook excerpt, not only the document title.
- Metric evidence is attached as collected evidence or explicit no-series evidence.
- Missing evidence stays visible instead of being hidden.
- No real customer secrets, identifiers, or production payloads are included.
