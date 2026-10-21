# Node.js Edtech Event Notifications: Auditing Transactional Email and SMS Delivery Status

The page fires at 08:42: `NOTICE_BATCH_UNRECONCILED`. On-call sees a Node.js event-notifications service with one enrollment-policy batch, 37 recipients lacking final transactional email or SMS delivery status, and 23 minutes left before the evidence deadline. Application errors are flat. The useful response is not to resend the alerts; it is to run the smallest reliable implementation for the no-webhooks constraint: **a durable outbox, a cron-triggered polling queue, and one auditable result per channel attempt**.

**TL;DR:** when a Node.js edtech service cannot accept webhooks, make reconciliation a batch-closing workflow rather than a collection of free-running status jobs. Persist the obligation before sending, poll outstanding remote identifiers from a cron-triggered queue, and close the batch only when every required attempt is terminal or explicitly routed for review. Page on an endangered deadline, not on a healthy cron process missing one tick.

This framing changes the implementation. The unit of concern is the compliance batch and its deadline; an individual poll is replaceable machinery. A queue can retry a lookup, but only the ledger can answer the auditor's question later.

## How should Node.js poll transactional email and SMS notifications?

A submission response establishes that a remote system accepted a request under some identifier. It does not, by itself, establish the later delivery state that the compliance record needs. Email and SMS also have different status vocabularies, so the enrollment service should never infer a shared meaning from similarly named strings. Model three records: the notice obligation, the channel attempt, and the status observation. The obligation says what the policy required at creation time. The attempt binds that requirement to a destination fingerprint, channel, idempotency key, and remote identifier. Observations are append-only facts containing the raw state and the time it was observed; a separate projection maps those facts to the few internal states used to close a batch. Keep the audit claim narrow, too: DMARC specifies policy and reporting around SPF and DKIM identifier alignment; it does not prove that a student or guardian read a message [1]. Apple documents that Mail Privacy Protection can download remote content in the background and prevent senders from learning Mail activity details [2]. An open pixel is therefore the wrong primitive for a compliance acknowledgment. If acknowledgment is required, collect an authenticated action in the education product and store it as a different event.

Short version: transport evidence is not consent.

## Make the worker contract deliberately narrow

The scheduled process should do very little. It selects due, nonterminal attempts; claims them for a bounded lease; and publishes their internal IDs to a retry queue. It does not send new notices, wait between calls, or decide that an unknown remote value means success. Workers reload current state before each lookup, append the observation, update the projection under a monotonic transition rule, and schedule another check only when the evidence horizon still permits one.

The following Go sketch shows the boundary even if the surrounding product is Node.js. The interface is intentionally smaller than any provider SDK, which keeps remote status vocabulary out of enrollment code and makes adapters independently testable.

```go
package evidence

import (
	"context"
	"time"
)

type Observation struct {
	RawState  string
	Observed  time.Time
	Terminal  bool
}

type StatusReader interface {
	Lookup(ctx context.Context, remoteID string) (Observation, error)
}

type Store interface {
	LoadOpenAttempt(ctx context.Context, attemptID string) (remoteID string, ok bool, err error)
	AppendAndProject(ctx context.Context, attemptID string, obs Observation) error
	ScheduleRetry(ctx context.Context, attemptID string, after time.Duration) error
}

func Reconcile(ctx context.Context, id string, reader StatusReader, store Store) error {
	remoteID, open, err := store.LoadOpenAttempt(ctx, id)
	if err != nil || !open {
		return err
	}
	obs, err := reader.Lookup(ctx, remoteID)
	if err != nil {
		return store.ScheduleRetry(ctx, id, 2*time.Minute)
	}
	return store.AppendAndProject(ctx, id, obs)
}
```

The two-minute delay is illustrative configuration, not a universal recommendation. Production policy needs separate treatment for network errors, explicit throttling, valid nonterminal states, and unknown values. Backoff should be bounded by the batch deadline and randomized enough that a recovered dependency does not receive the whole backlog at once.

There is a sharp duplicate boundary. A stable send key derived from the notice, recipient, channel, and policy version prevents concurrent application paths from creating two intended submissions. It cannot prove that a network timeout happened before or after remote acceptance. The send adapter therefore needs a documented idempotency contract or a review state for ambiguous submissions; blindly sending again turns an evidence gap into a duplicate legal notice.

Do not resend.

The limitation of scheduled polling is equally concrete. It is a poor fit when the status-query allowance cannot drain the due cohort inside the evidence SLO, when the remote system provides no stable lookup identifier, or when the workflow needs near-real-time acknowledgment. Choose a controlled event feed or an explicit in-product acknowledgment instead. That trade-off may require more inbound integration and operational controls, but adding cron workers cannot repair a missing identifier or an inadequate rate budget.

## Measure deadline debt before queue health

Work backward from the 08:42 page. Queue health did not explain the compliance exposure because workers could be green while old attempts accumulated. Instrumentation should publish the oldest unresolved attempt age and the unresolved count for each batch, with dimensions for region, channel, and notice type. Also record lookup errors, unknown raw states, rejected state regressions, and lease expirations. Message bodies and recipient addresses do not belong in metric labels or alert payloads.

The warning signal should have fired while enough deadline budget remained to drain the outstanding cohort. Express that as a burn condition against an internal evidence SLO: age is approaching the deadline and the unresolved population is material. A single stale test record belongs in a ticket. A growing required cohort belongs on the pager.

Capacity planning follows from reconciliation debt. For an illustrative batch of 60,000 recipients, two required attempts per recipient, and three observations per attempt, the service performs 360,000 lookups before transport retries. Over a two-hour window that averages 50 lookups per second. This is arithmetic, not a benchmark or a promise that an upstream contract permits the rate. Validate permitted query volume, regional burst shape, and batch lookup support before selecting worker concurrency.

Test the ugly distribution. Freeze some attempts near the deadline, return unknown values for others, inject timeouts, and verify that fresh low-priority work cannot starve the oldest required batch. Then stop a scheduler halfway through a claim and prove that leases return the work without submitting a second notice.

## Assign every continuing duty before choosing the machinery

The initial adapter is the visible work. The lasting integration includes status mapping, credential rotation, rate-limit handling, evidence retention, regional deployment, replay tooling, and an on-call runbook. A platform roadmap should compare who owns those duties, because a short setup can still create a long pager tail.

| Approach | Initial integration | Continuing ownership | Lock-in boundary | Failure the team must rehearse |
|---|---:|---|---|---|
| Direct channel adapters | Medium | Mapping, polling, throttling, and evidence storage | Remote identifiers and status schemas | Ambiguous submission plus a growing lookup backlog |
| Managed orchestration | Low to medium | Audit export, policy validation, and dependency review | Workflow model, retention, and export format | Control plane or regional dependency misses the evidence deadline |
| Self-hosted orchestration | High | Runtime, upgrades, capacity, adapters, and paging | Internal data model and deployment choices | Scheduler or storage degradation during a deadline burst |

No row wins by default. A small platform team may accept a broader external dependency to reduce adapter work, provided it can export raw observations and meet retention and regional requirements. A team with strict control requirements may own the orchestration, but then its staffing and recovery tests are part of the compliance design. The decision rule is concrete: choose the option whose evidence model you can verify and whose worst operational day the on-call rotation can absorb.

Deployment deserves the same skepticism. Add the obligation and observation records before switching the read path, dual-write new attempts, compare projections, and enable reconciliation by notice type. Historical application flags must not be upgraded into delivery evidence they never contained.

## What should the diagnostic page tell on-call?

At 08:42, the runbook should identify whether the gap began at submission, lookup, or projection. Missing remote identifiers point to the send boundary. Aging identifiers with lookup errors point to reconciliation. Fresh observations stuck in unknown or contradictory states point to mapping. Those branches need different recovery actions, even though the same audit batch exposed them.

Tune the alert from observed latency distributions and the internal objective, then review it after deadline bursts. A threshold set too late conceals an evidence gap; one set too early pages on ordinary delivery latency and spends scarce attention. That false-positive cost is real capacity consumption. The best alert leaves time for a bounded recovery, carries no personal data, and stays quiet when no compliance deadline is at risk.

## Further reading

- [RFC 7489: Domain-based Message Authentication, Reporting, and Conformance (DMARC)](https://datatracker.ietf.org/doc/html/rfc7489)
- [Apple: Use Mail Privacy Protection on iPhone](https://support.apple.com/guide/iphone/use-mail-privacy-protection-iphf084865c7/ios)
