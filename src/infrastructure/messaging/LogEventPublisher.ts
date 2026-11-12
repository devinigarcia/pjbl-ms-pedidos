import type { Logger } from 'pino';
import type { OrderIntegrationEvent } from '../../application/events/OrderIntegrationEvent';
import type { EventPublisher } from '../../application/ports/EventPublisher';

/**
 * Publicador para desenvolvimento, usado quando não há QUEUE_CONNECTION_STRING:
 * em vez de mandar para a fila, só escreve o evento no log.
 */
export class LogEventPublisher implements EventPublisher {
  readonly kind = 'log' as const;

  constructor(private readonly logger: Pick<Logger, 'info'>) {}

  async publish(event: OrderIntegrationEvent): Promise<void> {
    this.logger.info(
      { eventId: event.eventId, type: event.type, orderId: event.data.orderId, correlationId: event.correlationId },
      'evento "publicado" apenas no log (sem fila configurada)',
    );
  }
}
