import { z } from "zod";
import type { AppEnv } from "./types.ts";

const environmentSchema = z.object({
  APP_ID: z.string().min(1),
  APP_SLUG: z.literal("arshite"),
  WEBHOOK_SECRET: z.string().min(1),
  PRIVATE_KEY: z.string().optional(),
  PRIVATE_KEY_BASE64: z.string().optional(),
  CONFIG_FILENAME: z.string().min(1).default("pull.yml"),
  LOG_LEVEL: z.string().min(1).default("info"),
}).superRefine((environment, context) => {
  if (!environment.PRIVATE_KEY && !environment.PRIVATE_KEY_BASE64) {
    context.addIssue({
      code: "custom",
      message: "PRIVATE_KEY or PRIVATE_KEY_BASE64 is required",
    });
  }
});

function decodeBase64(value: string): string {
  const bytes = Uint8Array.from(
    atob(value),
    (character) => character.charCodeAt(0),
  );
  return new TextDecoder().decode(bytes);
}

export function loadEnv(source: Record<string, string | undefined>): AppEnv {
  const environment = environmentSchema.parse(source);
  const privateKey = environment.PRIVATE_KEY
    ? environment.PRIVATE_KEY.replaceAll("\\n", "\n")
    : decodeBase64(environment.PRIVATE_KEY_BASE64!);

  return {
    appId: environment.APP_ID,
    appSlug: environment.APP_SLUG,
    webhookSecret: environment.WEBHOOK_SECRET,
    privateKey,
    configFilename: environment.CONFIG_FILENAME,
    logLevel: environment.LOG_LEVEL,
  };
}
