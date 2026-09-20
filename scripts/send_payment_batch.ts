import { smsFromEnvironment } from "../src/infrai_sms.js";
import { campaignSchema, sendPaymentCampaign } from "../src/payment_notifications.js";

const phone = process.env.DEMO_SMS_TO;
if (!phone) throw new Error("DEMO_SMS_TO is required");

const input = campaignSchema.parse({
  campaignId: "settlement-2026-09-05",
  events: [
    {
      kind: "charge_succeeded",
      eventId: "pay_1042",
      accountId: "acct_81",
      phone,
      amountMinor: 2599,
      currency: "USD",
      occurredAt: "2026-09-05T08:30:00.000Z",
    },
  ],
});

console.log(JSON.stringify(await sendPaymentCampaign(input, smsFromEnvironment()), null, 2));
