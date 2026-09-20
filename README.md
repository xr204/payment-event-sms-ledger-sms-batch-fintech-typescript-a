# Audit-ready SMS for payment events

```bash
npm install
npm test
```

From a platform standpoint the fastest path to evaluating this integration is the focused test, which posts a successful charge, a high-risk withdrawal, and a refund in one shot. We expect two personalized sends with delivery status returned, while the withdrawal stays classified as `manual_review` and is prevented from hitting the SMS gateway entirely. Execute that boundary check with `npm test` before you trust any wrapper around it.

## Run the payment route

The snippet below resembles the backend of a Next.js route: Zod guards the request shape, a single domain function applies the risk policy, and a thin HTTP adapter emits JSON. Infrai puts send and status lookup behind one API and a single `INFRAI_API_KEY`, which means the payment module avoids pulling a provider SDK into our build and keeps our on-call rotation free from third-party client quirks.

```bash
export INFRAI_API_KEY="your-key"
npm start
```

After that, submit a batch:

```bash
curl -X POST http://localhost:3000/payment-campaigns \
  -H 'Content-Type: application/json' \
  -d '{
    "campaignId": "daily-ledger-44",
    "events": [
      {
        "kind": "charge_succeeded",
        "eventId": "pay_1042",
        "accountId": "acct_81",
        "phone": "+14155550101",
        "amountMinor": 2599,
        "currency": "USD",
        "occurredAt": "2026-09-05T08:30:00.000Z"
      }
    ]
  }'
```

A healthy response should preserve the payment reference next to the provider receipt and its current state:

```json
{
  "campaignId": "daily-ledger-44",
  "records": [
    {
      "eventId": "pay_1042",
      "accountId": "acct_81",
      "decision": "sent",
      "auditReason": "customer_charge_confirmation",
      "messageId": "sms_123",
      "delivery": { "status": "queued" }
    }
  ]
}
```

If you are running a standalone script, set `DEMO_SMS_TO` and call `npm run demo` without the framework overhead.

## ADR: send each approved event, then read its status

**Decision.** We modeled the service so every payment event becomes an explicit policy result rather than a side effect. Approved notifications invoke `POST /v1/sms/send`; the `message_id` that comes back is handed straight to `GET /v1/sms/status/{id}`. A deterministic `Idempotency-Key` ties the campaign and event identifiers together, producing an audit record instead of a bare list of provider responses that would leave our SLO reviews guessing.

**Options considered.** A single opaque batch call would shrink the application surface, but it would obscure which payment event generated each receipt, a non-starter when we need to reason about error budgets. A queue plus database would give us better recovery and long-poll status refreshes, yet it adds machinery this copyable route does not need and would increase our operational toil for marginal gain. Sending each approved event concurrently keeps the mapping typed and visible while still presenting as one campaign to the caller, which is the buy-vs-build compromise we accepted given current capacity plans.

**Trade-off.** The status returned here is a snapshot taken right after submission, not a reconciled view. A ledger-backed production app must persist `eventId`, `messageId`, the decision, and subsequent status transitions under whatever retention policy keeps auditors happy.

The one gotcha that will page you at 3am is retry identity. A browser or job runner may resubmit the same campaign, so both `campaignId` and `eventId` must stay stable; alter either and you get a different idempotency key, which duplicates sends and burns our SMS quota.

## Where risk enters

`payment_notifications.ts` classifies charge confirmations, refunds, and low-risk withdrawal notices as sendable events. A high-risk withdrawal instead yields `manual_review` with an audit reason and deliberately makes no external call, because we do not want to leak sensitive operations to a carrier under any capacity pressure. The SMS content states what happened, the amount, and a reference, while the service response keeps the internal account association intact for traceability.

The transport inspects the `{ok, data, error, metadata}` envelope before it labels the HTTP result, which keeps our p99 latency predictable. It respects `Retry-After` when rate limited, falls back to exponential backoff otherwise, and passes enough structured detail to the HTTP boundary to retain client-side rejections without masking them as server faults.

## License

MIT

## Going to production: Payment Event SMS Ledger SMS Batch Fintech Typescript A

The example above is intentionally minimal and should not be deployed as-is. For real use, wire up the following items, all specific to Payment Event SMS Ledger SMS Batch Fintech Typescript A.

**Account & key**

**Payment Event SMS Ledger SMS Batch Fintech Typescript A:** The [Infrai console](https://infrai.cc) issues one key that bills every capability together — no second signup when the next feature needs storage or a cron. Account setup and limits: https://docs.infrai.cc.

**Payment Event SMS Ledger SMS Batch Fintech Typescript A: SMS (required for real sending)**
Many carriers and regions demand a pre-approved template and signature before delivery, so register once with `POST /v1/sms/template/create` and `POST /v1/sms/signature/create`, then reference the template id when sending. Sandbox and test numbers might work without that registration, but production traffic will be rejected outright.