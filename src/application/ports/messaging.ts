import type { OutboxMessage } from '../../domain/outbox-message.js';

export interface QueueDelivery {
  body: string;
  receiptHandle: string;
  receiveCount: number;
  transportMessageId: string;
  groupId: string;
}
export interface WagerQueue {
  receive(signal?: AbortSignal): Promise<QueueDelivery[]>;
  acknowledge(delivery: QueueDelivery): Promise<void>;
  changeVisibility(delivery: QueueDelivery, seconds: number): Promise<void>;
  deadLetter(delivery: QueueDelivery, reason: string): Promise<void>;
}
export interface EventPublisher {
  publish(message: OutboxMessage, signal?: AbortSignal): Promise<void>;
}
