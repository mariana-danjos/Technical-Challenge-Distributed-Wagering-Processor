import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { SQL } from 'bun';
import { AppModule } from '../../src/app.module';
import { TEST_DATABASE_URL, setUpTestDatabase } from './test-database';

export interface HttpResponse<T = any> {
  status: number;
  headers: Headers;
  body: T;
}

export interface HttpHarness {
  sql: SQL;
  get<T = any>(path: string, headers?: Record<string, string>): Promise<HttpResponse<T>>;
  post<T = any>(path: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResponse<T>>;
  close(): Promise<void>;
}

/** The real AppModule (controllers, filter, guard, use cases, ORM) on the `wagering_test` DB. */
export async function startHttpHarness(): Promise<HttpHarness> {
  const { orm, sql } = await setUpTestDatabase();
  await orm.close();

  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.LOG_LEVEL ??= 'silent';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app: INestApplication = moduleRef.createNestApplication({ logger: false });
  await app.listen(0);
  const baseUrl = await app.getUrl();

  const request = async (method: string, path: string, body: unknown, headers: Record<string, string>) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined };
  };

  return {
    sql,
    get: (path, headers = {}) => request('GET', path, undefined, headers),
    post: (path, body, headers = {}) => request('POST', path, body, headers),
    close: async () => {
      await app.close();
      await sql.close();
    },
  };
}
