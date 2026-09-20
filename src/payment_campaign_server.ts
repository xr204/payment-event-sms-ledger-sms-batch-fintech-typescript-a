import { createServer } from "node:http";
import { ZodError } from "zod";
import { InfraiError, smsFromEnvironment } from "./infrai_sms.js";
import { campaignSchema, sendPaymentCampaign } from "./payment_notifications.js";

const port = Number(process.env.PORT ?? 3000);
const sms = smsFromEnvironment();

createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.method !== "POST" || request.url !== "/payment-campaigns") {
    response.writeHead(404).end(JSON.stringify({ error: "Route not found" }));
    return;
  }

  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = campaignSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const result = await sendPaymentCampaign(input, sms);
    response.writeHead(200).end(JSON.stringify(result));
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      response.writeHead(400).end(JSON.stringify({ error: "Invalid campaign body" }));
      return;
    }
    if (error instanceof InfraiError) {
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      response.writeHead(status).end(JSON.stringify({ error: error.detail }));
      return;
    }
    response.writeHead(502).end(JSON.stringify({ error: "Notification request could not be completed" }));
  }
}).listen(port, () => {
  console.log(`Payment campaign service listening on http://localhost:${port}`);
});
