import { describe, expect, it } from 'bun:test';
import { loadConfig } from '../../src/infrastructure/config/app-config';

const baseEnv = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

describe('loadConfig', () => {
  it('applies defaults when only required variables are set', () => {
    const config = loadConfig(baseEnv);

    expect(config.port).toBe(3000);
    expect(config.aws.endpoint).toBeUndefined();
    expect(config.sqs.wagerQueueName).toBe('wager-transactions.fifo');
    expect(config.sqs.wagerDlqName).toBe('wager-transactions-dlq.fifo');
  });

  it('enables workers by default and parses WORKERS_ENABLED strictly', () => {
    expect(loadConfig(baseEnv).workers.enabled).toBe(true);
    expect(loadConfig({ ...baseEnv, WORKERS_ENABLED: 'false' }).workers.enabled).toBe(false);
    expect(() => loadConfig({ ...baseEnv, WORKERS_ENABLED: 'no' })).toThrow('WORKERS_ENABLED');
  });

  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow('DATABASE_URL');
  });

  it.each(['abc', '-1', '3000.5', '70000'])('rejects invalid PORT %p', (port) => {
    expect(() => loadConfig({ ...baseEnv, PORT: port })).toThrow('Invalid PORT');
  });
});
