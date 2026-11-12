import { describe, expect, it } from 'vitest';
import type { OrderIntegrationEvent } from '../../../src/application/events/OrderIntegrationEvent';
import {
  AzureQueueEventPublisher,
  decodeQueueMessage,
  encodeQueueMessage,
  type QueueLike,
} from '../../../src/infrastructure/messaging/AzureQueueEventPublisher';
import { LogEventPublisher } from '../../../src/infrastructure/messaging/LogEventPublisher';
import { captureError } from '../../support/testKit';

const EVENT: OrderIntegrationEvent = {
  eventId: '0b6f3c52-8a41-4f0e-9a57-3d2c1b0a9e8d',
  type: 'order.created',
  version: 1,
  source: 'ms-pedidos',
  occurredAt: '2025-06-10T14:30:00.000Z',
  correlationId: 'corr-1',
  data: {
    orderId: '7f9c2b1e-4d3a-4c8e-9b2f-1a2b3c4d5e6f',
    customerName: 'João Conceição', // com acento, para conferir o UTF-8
    customerEmail: 'joao@exemplo.com',
    status: 'PENDENTE',
    total: 49.8,
    items: [{ productId: 'p-1', productName: 'Café torrado 500g', quantity: 2, unitPrice: 24.9 }],
  },
};

/** Fila de mentira: guarda as mensagens e pode falhar quando o teste pedir. */
class FakeQueue implements QueueLike {
  readonly messages: string[] = [];
  createCalls = 0;
  failCreate = false;
  failSend = false;

  async createIfNotExists(): Promise<unknown> {
    this.createCalls += 1;
    if (this.failCreate) throw new Error('sem acesso ao storage');
    return { succeeded: true };
  }

  async sendMessage(messageText: string): Promise<unknown> {
    if (this.failSend) throw new Error('fila fora do ar');
    this.messages.push(messageText);
    return { messageId: String(this.messages.length) };
  }
}

describe('AzureQueueEventPublisher', () => {
  it('envia o evento como JSON em Base64, que decodifica de volta para o mesmo evento', async () => {
    const queue = new FakeQueue();
    const publisher = new AzureQueueEventPublisher(queue);

    await publisher.publish(EVENT);

    expect(queue.messages).toHaveLength(1);
    const message = queue.messages[0]!;
    expect(message).toMatch(/^[A-Za-z0-9+/]+=*$/); // só caracteres de Base64
    expect(message).not.toContain('order.created');

    // o mesmo caminho que o gatilho de fila do Azure Functions faz
    const decoded: unknown = JSON.parse(Buffer.from(message, 'base64').toString('utf8'));
    expect(decoded).toEqual(EVENT);
    expect(decodeQueueMessage(message)).toEqual(EVENT);
    expect(encodeQueueMessage(EVENT)).toBe(message);
  });

  it('cria a fila só uma vez, mesmo publicando vários eventos', async () => {
    const queue = new FakeQueue();
    const publisher = new AzureQueueEventPublisher(queue);

    await Promise.all([publisher.publish(EVENT), publisher.publish(EVENT)]);
    await publisher.publish(EVENT);

    expect(queue.createCalls).toBe(1);
    expect(queue.messages).toHaveLength(3);
  });

  it('se não conseguir criar a fila, falha a publicação e tenta criar de novo na próxima', async () => {
    const queue = new FakeQueue();
    queue.failCreate = true;
    const publisher = new AzureQueueEventPublisher(queue);

    const error = await captureError(publisher.publish(EVENT));
    expect((error as Error).message).toBe('sem acesso ao storage');
    expect(queue.messages).toHaveLength(0);

    queue.failCreate = false;
    await publisher.publish(EVENT);
    expect(queue.createCalls).toBe(2);
    expect(queue.messages).toHaveLength(1);
  });

  it('repassa o erro de envio para o relay registrar a falha', async () => {
    const queue = new FakeQueue();
    queue.failSend = true;
    const publisher = new AzureQueueEventPublisher(queue);

    const error = await captureError(publisher.publish(EVENT));

    expect((error as Error).message).toBe('fila fora do ar');
  });

  it('informa o tipo certo para o /health', () => {
    expect(new AzureQueueEventPublisher(new FakeQueue()).kind).toBe('azure-queue');
    expect(new LogEventPublisher({ info: () => undefined }).kind).toBe('log');
  });

  it('monta o cliente a partir da connection string do Azurite sem abrir conexão', () => {
    const publisher = AzureQueueEventPublisher.fromConnectionString('UseDevelopmentStorage=true', 'order-events');
    expect(publisher.kind).toBe('azure-queue');
  });
});

describe('LogEventPublisher', () => {
  it('só registra o evento no log', async () => {
    const lines: unknown[] = [];
    const publisher = new LogEventPublisher({ info: (...args: unknown[]) => void lines.push(args[0]) });

    await publisher.publish(EVENT);

    expect(lines).toEqual([
      { eventId: EVENT.eventId, type: 'order.created', orderId: EVENT.data.orderId, correlationId: 'corr-1' },
    ]);
  });
});
