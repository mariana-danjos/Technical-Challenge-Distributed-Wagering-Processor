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

ATTRIBUTES=$(printf '{"FifoQueue":"true","VisibilityTimeout":"30","RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"%s\\",\\"maxReceiveCount\\":\\"5\\"}"}' "$DLQ_ARN")

awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "$ATTRIBUTES"

echo "SQS queues ready"
