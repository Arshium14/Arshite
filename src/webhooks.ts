export type WebhookPayload = Record<string, unknown>;

const encoder = new TextEncoder();

export async function verifyWebhookSignature(
  secret: string,
  body: string,
  signature: string | null,
): Promise<boolean> {
  const match = signature?.match(/^sha256=([0-9a-fA-F]{64})$/);
  if (!match) return false;

  const signatureBytes = new Uint8Array(32);
  for (let index = 0; index < signatureBytes.length; index++) {
    signatureBytes[index] = parseInt(
      match[1].slice(index * 2, index * 2 + 2),
      16,
    );
  }

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    encoder.encode(body),
  );
}

export function parseWebhook(
  body: string,
  event: string | null,
  delivery: string | null,
): { event: string; delivery: string; payload: WebhookPayload } {
  if (!event) throw new Error("Missing webhook event");
  if (!delivery) throw new Error("Missing webhook delivery");

  const payload: unknown = JSON.parse(body);
  if (
    typeof payload !== "object" || payload === null || Array.isArray(payload)
  ) {
    throw new Error("Webhook payload must be a JSON object");
  }

  return { event, delivery, payload: payload as WebhookPayload };
}
