import type { OrderIntegrationEvent } from '../events/OrderIntegrationEvent';

export type EventPublisherKind = 'azure-queue' | 'log';

/** Porta de saída para o mensageiro. Se `publish` lançar erro, o relay tenta de novo depois. */
export interface EventPublisher {
  readonly kind: EventPublisherKind;
  publish(event: OrderIntegrationEvent): Promise<void>;
}
