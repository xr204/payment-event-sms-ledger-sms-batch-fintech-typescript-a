import { z } from "zod";
import type { SmsGateway, SmsStatus } from "./infrai_sms.js";

const paymentEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("charge_succeeded"),
    eventId: z.string().min(1),
    accountId: z.string().min(1),
    phone: z.string().regex(/^\+[1-9]\d{7,14}$/),
    amountMinor: z.number().int().positive(),
    currency: z.string().length(3).transform((value) => value.toUpperCase()),
    occurredAt: z.string().datetime(),
  }),
  z.object({
    kind: z.literal("refund_issued"),
    eventId: z.string().min(1),
    accountId: z.string().min(1),
    phone: z.string().regex(/^\+[1-9]\d{7,14}$/),
    amountMinor: z.number().int().positive(),
    currency: z.string().length(3).transform((value) => value.toUpperCase()),
    occurredAt: z.string().datetime(),
  }),
  z.object({
    kind: z.literal("withdrawal_requested"),
    eventId: z.string().min(1),
    accountId: z.string().min(1),
    phone: z.string().regex(/^\+[1-9]\d{7,14}$/),
    amountMinor: z.number().int().positive(),
    currency: z.string().length(3).transform((value) => value.toUpperCase()),
    occurredAt: z.string().datetime(),
    risk: z.enum(["low", "high"]),
  }),
]);

export const campaignSchema = z.object({
  campaignId: z.string().min(1),
  events: z.array(paymentEventSchema).min(1).max(100),
});

export type CampaignInput = z.infer<typeof campaignSchema>;
type PaymentEvent = CampaignInput["events"][number];

export type NotificationRecord = {
  eventId: string;
  accountId: string;
  decision: "sent" | "manual_review";
  auditReason: string;
  messageId?: string;
  delivery?: SmsStatus;
};

function money(amountMinor: number, currency: string): string {
  return `${currency} ${(amountMinor / 100).toFixed(2)}`;
}

export function decideNotification(event: PaymentEvent):
  | { decision: "manual_review"; auditReason: string }
  | { decision: "send"; auditReason: string; body: string } {
  if (event.kind === "withdrawal_requested" && event.risk === "high") {
    return { decision: "manual_review", auditReason: "high_risk_withdrawal" };
  }

  const amount = money(event.amountMinor, event.currency);
  if (event.kind === "charge_succeeded") {
    return {
      decision: "send",
      auditReason: "customer_charge_confirmation",
      body: `Payment received: ${amount}. Reference ${event.eventId}.`,
    };
  }
  if (event.kind === "refund_issued") {
    return {
      decision: "send",
      auditReason: "customer_refund_confirmation",
      body: `Refund issued: ${amount}. Reference ${event.eventId}.`,
    };
  }
  return {
    decision: "send",
    auditReason: "low_risk_withdrawal_notice",
    body: `Withdrawal requested: ${amount}. Reference ${event.eventId}.`,
  };
}

export async function sendPaymentCampaign(
  input: CampaignInput,
  sms: SmsGateway,
): Promise<{ campaignId: string; records: NotificationRecord[] }> {
  const records = await Promise.all(input.events.map(async (event): Promise<NotificationRecord> => {
    const plan = decideNotification(event);
    if (plan.decision === "manual_review") {
      return {
        eventId: event.eventId,
        accountId: event.accountId,
        decision: "manual_review",
        auditReason: plan.auditReason,
      };
    }

    const sent = await sms.send(event.phone, plan.body, `${input.campaignId}:${event.eventId}`);
    const delivery = await sms.status(sent.message_id);
    return {
      eventId: event.eventId,
      accountId: event.accountId,
      decision: "sent",
      auditReason: plan.auditReason,
      messageId: sent.message_id,
      delivery,
    };
  }));

  return { campaignId: input.campaignId, records };
}
