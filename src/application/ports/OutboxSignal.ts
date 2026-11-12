/**
 * Aviso de que entrou mensagem nova no outbox.
 *
 * Os casos de uso que gravam evento (CreateOrder e o cancelamento em ChangeOrderStatus) chamam
 * `notify()` DEPOIS que a transação foi confirmada. Quem implementa é o relay, que publica na hora
 * em vez de ficar consultando o banco de tempos em tempos.
 *
 * `notify()` não espera a publicação e não lança erro: se a publicação falhar, o pedido já está
 * gravado e o relay tenta de novo sozinho.
 */
export interface OutboxSignal {
  notify(): void;
}

/** Para quem não tem relay ligado (testes, por exemplo). O POST /events/dispatch continua funcionando. */
export const noOutboxSignal: OutboxSignal = {
  notify() {
    // de propósito: sem relay, as mensagens ficam pendentes até um dispatch manual
  },
};
