import assert from "node:assert/strict";
import test from "node:test";
import type { SmsGateway } from "../src/infrai_sms.js";
import { campaignSchema, sendPaymentCampaign } from "../src/payment_notifications.js";

test("holds a high-risk withdrawal while sending auditable payment notices", async () => {
  const sends: Array<{ to: string; body: string; key: string }> = [];
  const sms: SmsGateway = {
    async send(to, body, key) {
      sends.push({ to, body, key });
      return { message_id: `sms_${sends.length}` };
    },
    async status(messageId) {
      return { status: messageId === "sms_1" ? "delivered" : "queued" };
    },
  };
  const input = campaignSchema.parse({
    campaignId: "daily-ledger-44",
    events: [
      { kind: "charge_succeeded", eventId: "pay_1", accountId: "acct_1", phone: "+14155550101", amountMinor: 4200, currency: "usd", occurredAt: "2026-09-05T08:00:00.000Z" },
      { kind: "withdrawal_requested", eventId: "wd_9", accountId: "acct_2", phone: "+14155550102", amountMinor: 700000, currency: "usd", occurredAt: "2026-09-05T08:01:00.000Z", risk: "high" },
      { kind: "refund_issued", eventId: "ref_3", accountId: "acct_3", phone: "+14155550103", amountMinor: 1250, currency: "eur", occurredAt: "2026-09-05T08:02:00.000Z" },
    ],
  });

  const result = await sendPaymentCampaign(input, sms);

  assert.deepEqual(sends, [
    { to: "+14155550101", body: "Payment received: USD 42.00. Reference pay_1.", key: "daily-ledger-44:pay_1" },
    { to: "+14155550103", body: "Refund issued: EUR 12.50. Reference ref_3.", key: "daily-ledger-44:ref_3" },
  ]);
  assert.deepEqual(result.records.map(({ eventId, decision, auditReason, delivery }) => ({ eventId, decision, auditReason, status: delivery?.status })), [
    { eventId: "pay_1", decision: "sent", auditReason: "customer_charge_confirmation", status: "delivered" },
    { eventId: "wd_9", decision: "manual_review", auditReason: "high_risk_withdrawal", status: undefined },
    { eventId: "ref_3", decision: "sent", auditReason: "customer_refund_confirmation", status: "queued" },
  ]);
});
