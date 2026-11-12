import { QueueClient } from '@azure/storage-queue';
import type { OrderIntegrationEvent } from '../../application/events/OrderIntegrationEvent';
import type { EventPublisher } from '../../application/ports/EventPublisher';

/** O pedacinho do QueueClient que o publicador usa. Ter essa interface permite trocar por um fake nos testes. */
export interface QueueLike {
  createIfNotExists(): Promise<unknown>;
  sendMessage(messageText: string): Promise<unknown>;
}

/**
 * O gatilho de fila do Azure Functions espera, por padrão, o corpo da mensagem em Base64.
 * Então a mensagem é o JSON do evento (UTF-8) codificado em Base64.
 */
export function encodeQueueMessage(event: OrderIntegrationEvent): string {
  return Buffer.from(JSON.stringify(event), 'utf8').toString('base64');
}

export function decodeQueueMessage(messageText: string): OrderIntegrationEvent {
  return JSON.parse(Buffer.from(messageText, 'base64').toString('utf8')) as OrderIntegrationEvent;
}

/** Publica os eventos na Azure Storage Queue (ou no Azurite, em desenvolvimento). */
export class AzureQueueEventPublisher implements EventPublisher {
  readonly kind = 'azure-queue' as const;
  private queueReady: Promise<void> | null = null;

  constructor(private readonly queue: QueueLike) {}

  static fromConnectionString(connectionString: string, queueName: string): AzureQueueEventPublisher {
    const client = new QueueClient(connectionString, queueName, {
      // poucas tentativas no SDK: quem insiste de verdade é o relay, na próxima rodada
      retryOptions: { maxTries: 2, tryTimeoutInMs: 10_000 },
    });
    return new AzureQueueEventPublisher(client);
  }

  async publish(event: OrderIntegrationEvent): Promise<void> {
    await this.ensureQueue();
    await this.queue.sendMessage(encodeQueueMessage(event));
  }

  // Cria a fila na primeira publicação. Se der erro, esquece o resultado para tentar de novo depois.
  private ensureQueue(): Promise<void> {
    if (!this.queueReady) {
      this.queueReady = this.queue.createIfNotExists().then(
        () => undefined,
        (error: unknown) => {
          this.queueReady = null;
          throw error;
        },
      );
    }
    return this.queueReady;
  }
}
