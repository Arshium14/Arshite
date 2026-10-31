import { assertEquals, assertThrows } from "@std/assert";
import { loadEnv } from "../src/env.ts";

const validEnv = {
  APP_ID: "12345",
  APP_SLUG: "arshite",
  WEBHOOK_SECRET: "test-webhook-secret",
  PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----",
};

Deno.test("loadEnv decodes escaped PEM newlines and applies defaults", () => {
  const env = loadEnv(validEnv);

  assertEquals(env, {
    appId: "12345",
    appSlug: "arshite",
    webhookSecret: "test-webhook-secret",
    privateKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
    configFilename: "pull.yml",
    logLevel: "info",
  });
});

Deno.test("loadEnv decodes a base64 private key", () => {
  const privateKey =
    "-----BEGIN PRIVATE KEY-----\nbase64-key\n-----END PRIVATE KEY-----";
  const env = loadEnv({
    ...validEnv,
    PRIVATE_KEY: undefined,
    PRIVATE_KEY_BASE64: btoa(privateKey),
    CONFIG_FILENAME: "custom.yml",
    LOG_LEVEL: "debug",
  });

  assertEquals(env.privateKey, privateKey);
  assertEquals(env.configFilename, "custom.yml");
  assertEquals(env.logLevel, "debug");
});

Deno.test("loadEnv rejects missing credentials", () => {
  const missingCredentials = [
    { ...validEnv, APP_ID: undefined },
    { ...validEnv, APP_SLUG: undefined },
    { ...validEnv, WEBHOOK_SECRET: undefined },
    { ...validEnv, APP_ID: "" },
    { ...validEnv, WEBHOOK_SECRET: "" },
    {
      APP_ID: validEnv.APP_ID,
      APP_SLUG: validEnv.APP_SLUG,
      WEBHOOK_SECRET: validEnv.WEBHOOK_SECRET,
    },
  ];

  for (const source of missingCredentials) {
    assertThrows(() => loadEnv(source));
  }
});

Deno.test("loadEnv requires the Arshite app slug", () => {
  assertThrows(() => loadEnv({ ...validEnv, APP_SLUG: "another-app" }));
});
