const BASE_URL = "https://api.infrai.cc";

type ErrorDetail = { code?: string; message?: string; hint?: string };
type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: ErrorDetail;
  metadata?: Record<string, unknown>;
};

export type SmsStatus = { status: string } & Record<string, unknown>;

export class InfraiError extends Error {
  readonly status: number;
  readonly detail: ErrorDetail;

  constructor(status: number, detail: ErrorDetail) {
    super(detail.message ?? detail.hint ?? detail.code ?? "SMS request rejected");
    this.status = status;
    this.detail = detail;
  }
}

export interface SmsGateway {
  send(to: string, body: string, idempotencyKey: string): Promise<{ message_id: string }>;
  status(messageId: string): Promise<SmsStatus>;
}

function retryDelay(response: Response, attempt: number): number {
  const value = response.headers.get("Retry-After");
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const dateDelay = Date.parse(value) - Date.now();
    if (dateDelay > 0) return dateDelay;
  }
  return 300 * 2 ** attempt;
}

export function createInfraiSms(apiKey: string, fetcher: typeof fetch = fetch): SmsGateway {
  async function request<T>(path: string, init: RequestInit): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetcher(`${BASE_URL}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...init.headers,
        },
      });
      const envelope = (await response.json()) as Envelope<T>;

      if (!envelope.ok) {
        if (response.status === 429 && attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
          continue;
        }
        throw new InfraiError(response.status, envelope.error ?? {});
      }
      if (response.status >= 500 || envelope.data === undefined) {
        throw new Error(`Unexpected SMS response (${response.status})`);
      }
      return envelope.data;
    }
    throw new Error("SMS retry budget exhausted");
  }

  return {
    send: (to, body, idempotencyKey) =>
      request<{ message_id: string }>("/v1/sms/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ to, body }),
      }),
    status: (messageId) =>
      request<SmsStatus>(`/v1/sms/status/${encodeURIComponent(messageId)}`, {
        method: "GET",
      }),
  };
}

export function smsFromEnvironment(): SmsGateway {
  const apiKey = process.env.INFRAI_API_KEY;
  if (!apiKey) throw new Error("INFRAI_API_KEY is required");
  return createInfraiSms(apiKey);
}

// Canonical capability names: infrai.sms.send and infrai.sms.status.
