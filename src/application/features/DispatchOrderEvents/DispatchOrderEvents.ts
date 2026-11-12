import type { EventPublisher } from '../../ports/EventPublisher';
import type { OutboxRepository } from '../../ports/OutboxRepository';

export interface DispatchOrderEventsResult {
  /** Mensagens publicadas nesta rodada. */
  published: number;
  /** Mensagens que falharam nesta rodada (serão tentadas de novo). */
  failed: number;
  /** Quantas continuam sem publicar depois da rodada (inclui as que falharam). */
  pending: number;
}

export interface DispatchOrderEventsOptions {
  /** Máximo de mensagens por rodada. */
  batchSize?: number;
  now?: () => Date;
}

const LAST_ERROR_MAX_LENGTH = 1000; // tamanho da coluna LastError

/**
 * O "relay" do Transactional Outbox: pega as mensagens pendentes, publica uma a uma e dá baixa.
 * É chamado pelo timer em background e também pelo POST /events/dispatch.
 *
 * A entrega é "pelo menos uma vez": se publicar e cair antes de marcar ProcessedAt,
 * a mensagem sai de novo na próxima rodada. Por isso os consumidores são idempotentes (eventId).
 */
export class DispatchOrderEventsHandler {
  private readonly batchSize: number;
  private readonly now: () => Date;
  private running: Promise<DispatchOrderEventsResult> | null = null;

  constructor(
    private readonly outbox: OutboxRepository,
    private readonly publisher: EventPublisher,
    options: DispatchOrderEventsOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 20;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Nunca roda duas vezes ao mesmo tempo neste processo: quem chamar durante uma rodada
   * em andamento recebe o resultado dela (senão a mesma mensagem poderia ser publicada em dobro).
   */
  execute(): Promise<DispatchOrderEventsResult> {
    if (!this.running) {
      this.running = this.dispatch().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async dispatch(): Promise<DispatchOrderEventsResult> {
    const messages = await this.outbox.fetchPending(this.batchSize);
    let published = 0;
    let failed = 0;

    for (const message of messages) {
      try {
        await this.publisher.publish(message.payload);
      } catch (error) {
        failed += 1;
        await this.outbox.markFailed(message.id, describeError(error));
        continue;
      }
      // Só marca depois que a fila confirmou o recebimento.
      await this.outbox.markProcessed(message.id, this.now());
      published += 1;
    }

    const pending = await this.outbox.countPending();
    return { published, failed, pending };
  }
}

function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (text || 'Erro desconhecido ao publicar o evento.').slice(0, LAST_ERROR_MAX_LENGTH);
}
