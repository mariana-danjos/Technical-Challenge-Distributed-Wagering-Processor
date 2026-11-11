export const APP_CONFIG = Symbol('APP_CONFIG');

export interface AppConfig {
  port: number;
  logLevel: string;
  databaseUrl: string;
  aws: {
    region: string;
    endpoint: string | undefined;
  };
  sqs: {
    wagerQueueName: string;
    wagerDlqName: string;
  };
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env): AppConfig {
  return {
    port: parsePort(env.PORT ?? '3000'),
    logLevel: env.LOG_LEVEL ?? 'info',
    databaseUrl: required(env, 'DATABASE_URL'),
    aws: {
      region: env.AWS_REGION ?? 'us-east-1',
      endpoint: env.AWS_ENDPOINT_URL || undefined,
    },
    sqs: {
      wagerQueueName: env.SQS_WAGER_QUEUE_NAME ?? 'wager-transactions.fifo',
      wagerDlqName: env.SQS_WAGER_DLQ_NAME ?? 'wager-transactions-dlq.fifo',
    },
  };
}

function required(env: Env, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`Missing required environment variable ${key}`);
  }
  return value;
}

function parsePort(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid PORT: "${raw}"`);
  }
  const port = Number.parseInt(raw, 10);
  if (port > 65535) {
    throw new Error(`Invalid PORT: "${raw}"`);
  }
  return port;
}
