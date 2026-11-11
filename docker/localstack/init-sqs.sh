#!/bin/bash
# Runs inside LocalStack once SQS is ready. Idempotent: create-queue returns the existing queue.
set -euo pipefail

DLQ_URL=$(awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true \
  --query QueueUrl --output text)

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

# maxReceiveCount counts every receive: transient retries, but also releases (shutdown, batch
# deadline, or an earlier message of the same FIFO group being retried). Permanent failures are
# sent to the DLQ explicitly by the consumer. With the consumer's backoff (2s doubling, capped at
# 300s), 30 receives keep a retried message alive ~2h — enough to ride out a DB or SQS outage.
ATTRIBUTES=$(printf '{"FifoQueue":"true","VisibilityTimeout":"30","RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"%s\\",\\"maxReceiveCount\\":\\"30\\"}"}' "$DLQ_ARN")

awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "$ATTRIBUTES"

# Integration events published by the outbox. Group = walletId, deduplication id = eventId.
awslocal sqs create-queue \
  --queue-name wager-events.fifo \
  --attributes FifoQueue=true

echo "SQS queues ready"
