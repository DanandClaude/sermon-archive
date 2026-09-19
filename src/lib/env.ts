import { z } from 'zod';

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v?.trim() ? v.trim() : undefined));

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // `real` is only honoured in production; see resolveAdapterMode.
  ADAPTER_MODE: z.enum(['fake', 'real']).default('fake'),
  /** Public address of this deployment. Used in emailed sign-in links, never taken from a request. */
  APP_URL: optionalString.pipe(z.url().optional()),
  SMTP_URL: optionalString,
  MAIL_FROM: optionalString,
  S3_BUCKET: optionalString,
  S3_REGION: optionalString,
  /**
   * 32 random bytes as 64 hex characters (`openssl rand -hex 32`). Encrypts storage credentials
   * at rest. Required in production; development falls back to a fixed, insecure key.
   */
  SECRETS_KEY: optionalString.pipe(
    z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'SECRETS_KEY must be 64 hex characters (openssl rand -hex 32)')
      .optional(),
  ),
  /** OAuth client for connecting Google Drive. Only used when ADAPTER_MODE=real. */
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  /** Set for S3-compatible services other than AWS (Cloudflare R2, MinIO, Backblaze). */
  S3_ENDPOINT: optionalString,
});

const REAL_MODE_REQUIRED = [
  'SMTP_URL',
  'MAIL_FROM',
  'S3_BUCKET',
  'S3_REGION',
  'SECRETS_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
] as const;

const envSchema = baseSchema
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.APP_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_URL'],
        message: 'APP_URL is required in production',
      });
    }
    if (env.NODE_ENV === 'production' && !env.SECRETS_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['SECRETS_KEY'],
        message: 'SECRETS_KEY is required in production',
      });
    }
    if (env.ADAPTER_MODE === 'real') {
      for (const key of REAL_MODE_REQUIRED) {
        if (!env[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required when ADAPTER_MODE=real`,
          });
        }
      }
    }
  })
  .transform((env) => ({
    ...env,
    APP_URL: (env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
  }));

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

let cached: Env | undefined;

/** Parsed lazily so `next build` doesn't need runtime secrets. */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
