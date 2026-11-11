import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';

/** Resolves queue names to URLs on first use and caches them. */
export class SqsQueueUrls {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(private readonly sqs: SQSClient) {}

  resolve(queueName: string): Promise<string> {
    let url = this.cache.get(queueName);
    if (!url) {
      url = this.sqs.send(new GetQueueUrlCommand({ QueueName: queueName })).then((response) => {
        if (!response.QueueUrl) throw new Error(`Queue ${queueName} not found`);
        return response.QueueUrl;
      });
      // Do not cache failures: the queue (or SQS) may only be temporarily unavailable.
      url.catch(() => this.cache.delete(queueName));
      this.cache.set(queueName, url);
    }
    return url;
  }
}
