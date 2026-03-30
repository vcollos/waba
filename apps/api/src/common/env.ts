import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

try {
  loadEnvFile();
} catch {
  // Optional local .env file.
}

export interface AppEnv {
  port: number;
  corsOrigin: string;
  adminEmail: string;
  adminPassword: string;
  jwtSecret: string;
  encryptionKey: string;
  sqlitePath: string;
  legacyDataFilePath: string;
  webhookPath: string;
  optOutKeywords: string[];
  metaAllowInsecureTls: boolean;
  metaIntegration?: {
    name: string;
    graphApiBase: string;
    graphApiVersion: string;
    wabaId: string;
    phoneNumberId: string;
    accessToken: string;
    verifyToken: string;
    appSecret?: string;
    webhookCallbackUrl?: string;
  };
}

const required = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
};

export const getEnv = (): AppEnv => {
  const port = Number(process.env.PORT ?? 4311);
  const corsOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:4310';
  const adminEmail = process.env.ADMIN_EMAIL ?? 'admin@example.com';
  const adminPassword = process.env.ADMIN_PASSWORD ?? 'admin123';
  const jwtSecret = required('JWT_SECRET', 'pilot-secret-change-me');
  const encryptionKey = createHash('sha256')
    .update(required('APP_ENCRYPTION_KEY', 'pilot-encryption-key-change-me'))
    .digest('hex');
  const sqlitePath =
    process.env.SQLITE_PATH ?? resolve(process.cwd(), 'data/campaign-sender.sqlite');
  const legacyDataFilePath =
    process.env.LEGACY_DATA_FILE_PATH ??
    resolve(process.cwd(), 'data/campaign-sender.json');
  const webhookPath = process.env.WEBHOOK_PATH ?? '/api/webhooks/meta/whatsapp';
  const optOutKeywords = (process.env.OPT_OUT_KEYWORDS ?? 'PARAR,SAIR,STOP,CANCELAR,REMOVER')
    .split(',')
    .map((keyword) => keyword.trim().toUpperCase())
    .filter(Boolean);
  const metaAllowInsecureTls = isEnabled(process.env.META_ALLOW_INSECURE_TLS);

  const metaAccessToken = normalizeOptionalSecret(process.env.META_ACCESS_TOKEN);
  const metaVerifyToken = normalizeOptionalSecret(process.env.META_VERIFY_TOKEN);
  const metaWabaId = normalizeOptionalSecret(process.env.META_WABA_ID);
  const metaPhoneNumberId = normalizeOptionalSecret(process.env.META_PHONE_NUMBER_ID);

  return {
    port,
    corsOrigin,
    adminEmail,
    adminPassword,
    jwtSecret,
    encryptionKey,
    sqlitePath,
    legacyDataFilePath,
    webhookPath,
    optOutKeywords,
    metaAllowInsecureTls,
    metaIntegration:
      metaAccessToken && metaVerifyToken && metaWabaId && metaPhoneNumberId
        ? {
            name: process.env.META_INTEGRATION_NAME?.trim() || 'Collos WABA',
            graphApiBase:
              process.env.META_GRAPH_API_BASE?.trim() || 'https://graph.facebook.com',
            graphApiVersion: process.env.META_GRAPH_API_VERSION?.trim() || 'v23.0',
            wabaId: metaWabaId,
            phoneNumberId: metaPhoneNumberId,
            accessToken: metaAccessToken,
            verifyToken: metaVerifyToken,
            appSecret: normalizeOptionalSecret(process.env.META_APP_SECRET),
            webhookCallbackUrl:
              normalizeOptionalSecret(process.env.META_WEBHOOK_CALLBACK_URL) || undefined,
          }
        : undefined,
  };
};

const normalizeOptionalSecret = (value?: string): string | undefined => {
  const normalized = value?.trim();
  if (!normalized || normalized.includes('COLE_AQUI')) {
    return undefined;
  }

  return normalized;
};

const isEnabled = (value?: string): boolean => {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
};
