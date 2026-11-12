import type { Logger } from 'pino';
import type { OutboxSignal } from '../../application/ports/OutboxSignal';

export interface RelayRunResult {
  published: number;
  failed: number;
  pending: number;
}

/**
 * Relay do Transactional Outbox, orientado a sinal (não fica fazendo polling para sempre).
 *
 * Por quê: o Azure SQL gratuito pausa depois de alguns minutos sem uso e tem cota mensal.
 * Um relay consultando o banco a cada 3 segundos nunca deixaria o banco pausar e gastaria
 * a cota em poucos dias. Então ele só toca no banco quando existe motivo:
 *
 *  - `start()`: uma varredura única na subida (pega o que ficou para trás se o processo caiu
 *    entre o commit do pedido e a publicação);
 *  - `notify()`: um caso de uso acabou de gravar no outbox, publica agora;
 *  - nova tentativa: se depois de uma rodada sobrou mensagem pendente (ou a rodada deu erro),
 *    agenda outra para daqui a `retryIntervalMs`;
 *  - outbox vazio: fica ocioso, sem timer e sem consulta nenhuma.
 *
 * Nunca rodam duas rodadas ao mesmo tempo. Se chegar um `notify()` no meio de uma,
 * outra rodada começa logo em seguida, para o evento novo não ficar esperando.
 */
export class OutboxRelay implements OutboxSignal {
  private started = false;
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  private runAgain = false;

  constructor(
    private readonly dispatch: () => Promise<RelayRunResult>,
    private readonly retryIntervalMs: number,
    private readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.trigger();
  }

  notify(): void {
    if (!this.started) return;
    this.trigger();
  }

  /** Cancela a tentativa agendada e espera a rodada em andamento terminar (desligamento do serviço). */
  async stop(): Promise<void> {
    this.started = false;
    this.clearTimer();
    await this.whenIdle();
  }

  /** Resolve quando não há rodada em andamento. */
  async whenIdle(): Promise<void> {
    while (this.current) {
      await this.current;
    }
  }

  private trigger(): void {
    if (this.current) {
      // já tem rodada em andamento: marca para rodar mais uma assim que ela acabar
      this.runAgain = true;
      return;
    }
    this.clearTimer();
    this.current = this.cycle().finally(() => {
      this.current = null;
    });
  }

  private async cycle(): Promise<void> {
    for (;;) {
      this.runAgain = false;
      const hasLeftovers = await this.runOnce();

      if (!this.started) return;
      if (this.runAgain) continue;
      if (hasLeftovers) this.scheduleRetry();
      return;
    }
  }

  /** Executa uma rodada e diz se ficou algo para tentar de novo mais tarde. */
  private async runOnce(): Promise<boolean> {
    try {
      const result = await this.dispatch();
      if (result.failed > 0) {
        this.logger.warn(result, 'outbox: falha ao publicar, nova tentativa agendada');
      } else if (result.published > 0) {
        this.logger.info(result, 'outbox: eventos publicados');
      }
      return result.pending > 0;
    } catch (error) {
      this.logger.error({ err: error }, 'outbox: erro na rodada do relay, nova tentativa agendada');
      return true;
    }
  }

  private scheduleRetry(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.started) this.trigger();
    }, this.retryIntervalMs);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
