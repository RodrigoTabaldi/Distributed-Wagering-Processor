import { createSqsClient, provisionQueues } from './sqs.js';
const client = createSqsClient();
try {
  await provisionQueues(client);
  console.log('SQS FIFO queues and DLQ redrive policy configured');
} finally {
  client.destroy();
}
