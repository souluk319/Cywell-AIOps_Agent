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

## Simulation Learning Flow

The v0.1.1 Simulation Lab is not prompt hardcoding. It is a synthetic
operations world made of scenario JSON, OpenShift-like evidence, metric
responses, and JSONL runbook hits.

The intended learning cycle is:

1. Select a scenario in the CAS Simulation tab.
2. Run `1. Analyze Issue`.
3. Read the streamed chat answer, RCA trace, evidence summary, and runbook hits.
4. Click the scenario-specific `2. ... simulation` recovery action.
5. Confirm that warning events, restart increase, pod state, and metric signals
   changed as expected.
6. Use the follow-up chips under the answer to ask for a report, safe commands,
   remaining risk, or handoff summary.
7. Return to the Simulation tab and repeat with a different failure class.

Current synthetic scenario classes:

- workload memory pressure and OOMKilled
- scheduling quota or capacity Pending
- readiness probe dependency timeout
- registry and pull secret ImagePullBackOff
- CrashLoopBackOff from missing Secret or ConfigMap reference
- Route 5xx from backend readiness loss
- PVC mount and attach failure
- DNS or NetworkPolicy dependency timeout

Every scenario must include:

- `learning.objective`
- `learning.cycle`
- `learning.checkpoints`
- `learning.followUps`
- at least one remediation with `expectedOutcome`
- customer-specific runbook hits through `apps/gateway/runbooks/komsco-ops-sim.jsonl`
