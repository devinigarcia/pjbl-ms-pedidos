import type { OrderEventType } from '../../domain/order/OrderEvents';
import type { OrderIntegrationEvent } from '../events/OrderIntegrationEvent';

/** Uma linha da tabela OutboxMessages. */
export interface OutboxMessage {
  /** Igual ao `eventId` do payload. */
  id: string;
  type: OrderEventType;
  /** Id do pedido que gerou o evento. */
  aggregateId: string;
  payload: OrderIntegrationEvent;
  occurredAt: Date;
  /** Preenchido quando a mensagem foi publicada na fila. */
  processedAt: Date | null;
  /** Quantas vezes o relay tentou publicar. */
  attempts: number;
  /** Erro da última tentativa que falhou (some quando publica). */
  lastError: string | null;
}

/**
 * Leitura e baixa das mensagens do outbox. A GRAVAÇÃO não está aqui de propósito:
 * ela acontece dentro do OrderRepository, na mesma transação do pedido.
 */
export interface OutboxRepository {
  /** Mensagens mais recentes primeiro, e o total geral da tabela. */
  listRecent(limit: number): Promise<{ items: OutboxMessage[]; total: number }>;
  /** Mensagens ainda não publicadas, das mais antigas para as mais novas. */
  fetchPending(limit: number): Promise<OutboxMessage[]>;
  markProcessed(id: string, processedAt: Date): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  countPending(): Promise<number>;
}
