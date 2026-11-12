import type { OutboxMessage } from '../../application/ports/OutboxRepository';
import type { OrderProps } from '../../domain/order/Order';

export interface StoredOrder {
  props: OrderProps;
  /** Ordem de inserção, usada só para desempatar pedidos criados no mesmo milissegundo. */
  sequence: number;
}

export interface StoredOutboxMessage {
  message: OutboxMessage;
  sequence: number;
}

/**
 * "Banco" em memória, compartilhado pelos dois repositórios (pedidos e outbox), do mesmo jeito
 * que as tabelas ficam no mesmo banco SQL. Serve para desenvolvimento e para os testes.
 */
export class InMemoryDatabase {
  readonly orders = new Map<string, StoredOrder>();
  readonly outbox: StoredOutboxMessage[] = [];
  private sequence = 0;

  nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }
}

export function cloneOrderProps(props: OrderProps): OrderProps {
  return {
    ...props,
    items: props.items.map((item) => ({ ...item })),
    createdAt: new Date(props.createdAt),
    updatedAt: new Date(props.updatedAt),
  };
}

export function cloneOutboxMessage(message: OutboxMessage): OutboxMessage {
  return {
    ...message,
    // o payload passa por JSON, igual acontece na coluna NVARCHAR(MAX) do SQL
    payload: JSON.parse(JSON.stringify(message.payload)) as OutboxMessage['payload'],
    occurredAt: new Date(message.occurredAt),
    processedAt: message.processedAt ? new Date(message.processedAt) : null,
  };
}
