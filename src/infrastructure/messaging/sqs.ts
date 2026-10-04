import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  SendMessageCommand,
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  GetQueueUrlCommand,
} from '@aws-sdk/client-sqs';
import { createHash } from 'node:crypto';
import type {
  EventPublisher,
  QueueDelivery,
  WagerQueue,
} from '../../application/ports/messaging.js';
import type { OutboxMessage } from '../../domain/outbox-message.js';
import { MAX_RECEIVE_ATTEMPTS } from '../../interfaces/sqs/wager-consumer.js';

export function createSqsClient(): SQSClient {
  const endpoint = process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566';
  const local = ['127.0.0.1', 'localhost'].includes(new URL(endpoint).hostname);
  // Credenciais fictícias valem só para o emulador local. AWS usa a cadeia padrão de credenciais.
  return new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint,
    ...(local
      ? { credentials: { accessKeyId: 'test', secretAccessKey: 'test' } }
      : {}),
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 3000, requestTimeout: 25000 },
  });
}
export interface QueueUrls {
  input: string;
  dlq: string;
  events: string;
}
export async function resolveQueues(client: SQSClient): Promise<QueueUrls> {
  const names = [
    'wager-transactions.fifo',
    'wager-transactions-dlq.fifo',
    'wager-events.fifo',
  ];
  const urls = await Promise.all(
    names.map(async (QueueName) => {
      const result = await client.send(new GetQueueUrlCommand({ QueueName }));
      if (!result.QueueUrl) throw new Error('SQS queue URL missing');
      return result.QueueUrl;
    }),
  );
  return { input: urls[0]!, dlq: urls[1]!, events: urls[2]! };
}
export async function provisionQueues(
  client: SQSClient,
  prefix = '',
): Promise<QueueUrls> {
  const create = async (name: string) => {
    const result = await client.send(
      new CreateQueueCommand({
        QueueName: `${prefix}${name}.fifo`,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
          VisibilityTimeout: '30',
          ReceiveMessageWaitTimeSeconds: '20',
          MessageRetentionPeriod: '1209600',
        },
      }),
    );
    if (!result.QueueUrl) throw new Error('SQS queue creation returned no URL');
    return result.QueueUrl;
  };
  const dlq = await create('wager-transactions-dlq');
  const events = await create('wager-events');
  const input = await create('wager-transactions');
  const attributes = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlq,
      AttributeNames: ['QueueArn'],
    }),
  );
  if (!attributes.Attributes?.QueueArn) throw new Error('DLQ ARN missing');
  await client.send(
    new SetQueueAttributesCommand({
      QueueUrl: input,
      Attributes: {
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: attributes.Attributes.QueueArn,
          maxReceiveCount: MAX_RECEIVE_ATTEMPTS,
        }),
      },
    }),
  );
  return { input, dlq, events };
}

export class SqsTransport implements WagerQueue, EventPublisher {
  constructor(
    readonly client: SQSClient,
    readonly urls: QueueUrls,
    private readonly waitSeconds = 20,
  ) {}
  async receive(signal?: AbortSignal): Promise<QueueDelivery[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.urls.input,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: this.waitSeconds,
        VisibilityTimeout: 30,
        MessageSystemAttributeNames: [
          'ApproximateReceiveCount',
          'MessageGroupId',
        ],
      }),
      { abortSignal: signal },
    );
    return (response.Messages ?? []).map((message) => {
      if (!message.Body || !message.ReceiptHandle || !message.MessageId)
        throw new Error('Incomplete SQS delivery');
      return {
        body: message.Body,
        receiptHandle: message.ReceiptHandle,
        transportMessageId: message.MessageId,
        receiveCount: Number(
          message.Attributes?.ApproximateReceiveCount ?? '1',
        ),
        groupId: message.Attributes?.MessageGroupId ?? 'invalid-message',
      };
    });
  }
  async acknowledge(delivery: QueueDelivery): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.urls.input,
        ReceiptHandle: delivery.receiptHandle,
      }),
    );
  }
  async changeVisibility(
    delivery: QueueDelivery,
    seconds: number,
  ): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.urls.input,
        ReceiptHandle: delivery.receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }
  async deadLetter(delivery: QueueDelivery, reason: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.urls.dlq,
        MessageBody: delivery.body,
        MessageGroupId: delivery.groupId,
        MessageDeduplicationId: createHash('sha256')
          .update(delivery.transportMessageId)
          .digest('hex'),
        MessageAttributes: {
          FailureReason: { DataType: 'String', StringValue: reason },
        },
      }),
    );
  }
  async publish(message: OutboxMessage, signal?: AbortSignal): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.urls.events,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
      }),
      { abortSignal: signal },
    );
  }
}
