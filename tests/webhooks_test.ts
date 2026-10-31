import { assertEquals, assertThrows } from "@std/assert";
import { parseWebhook, verifyWebhookSignature } from "../src/webhooks.ts";

const encoder = new TextEncoder();

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const hex = Array.from(
    new Uint8Array(signature),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256=${hex}`;
}

Deno.test("webhook signature accepts a valid HMAC-SHA256 signature", async () => {
  const body = JSON.stringify({ action: "opened", number: 42 });
  const signature = await sign("test-secret", body);

  assertEquals(
    await verifyWebhookSignature("test-secret", body, signature),
    true,
  );
});

Deno.test("webhook signature rejects an invalid signature", async () => {
  const body = JSON.stringify({ action: "opened" });
  const signature = await sign("test-secret", body);
  const lastDigit = signature.at(-1);
  const invalidSignature = `${signature.slice(0, -1)}${
    lastDigit === "0" ? "1" : "0"
  }`;

  assertEquals(
    await verifyWebhookSignature("test-secret", body, invalidSignature),
    false,
  );
});

Deno.test("webhook signature rejects a missing signature", async () => {
  assertEquals(
    await verifyWebhookSignature("test-secret", "{}", null),
    false,
  );
});

Deno.test("webhook signature rejects malformed values without throwing", async () => {
  const validSignature = await sign("test-secret", "{}");
  const malformedSignatures = [
    validSignature.slice("sha256=".length),
    `sha1=${validSignature.slice("sha256=".length)}`,
    "sha256=not-hex",
    `sha256=${"0".repeat(63)}`,
    `sha256=${"0".repeat(65)}`,
    `${validSignature}0`,
    "",
  ];

  for (const signature of malformedSignatures) {
    assertEquals(
      await verifyWebhookSignature("test-secret", "{}", signature),
      false,
    );
  }
});

Deno.test("parseWebhook returns explicit metadata and an object payload", () => {
  const payload = {
    action: "added",
    installation: { id: 42 },
    repositories: [{ id: 7, full_name: "org/example" }],
  };

  assertEquals(
    parseWebhook(
      JSON.stringify(payload),
      "installation_repositories",
      "delivery-1",
    ),
    {
      event: "installation_repositories",
      delivery: "delivery-1",
      payload,
    },
  );
});

Deno.test("parseWebhook rejects malformed JSON", () => {
  assertThrows(() => parseWebhook("{", "push", "delivery-1"));
});

Deno.test("parseWebhook rejects non-object JSON payloads", () => {
  for (const body of ["null", "[]", '"text"', "42", "true"]) {
    assertThrows(() => parseWebhook(body, "push", "delivery-1"));
  }
});

Deno.test("parseWebhook rejects a missing event", () => {
  assertThrows(() => parseWebhook("{}", null, "delivery-1"));
});

Deno.test("parseWebhook rejects a missing delivery", () => {
  assertThrows(() => parseWebhook("{}", "push", null));
});
