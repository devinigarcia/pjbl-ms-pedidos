/**
 * Uma dependência externa (hoje, o banco) está fora do ar por um instante.
 * Não é regra de negócio, por isso não fica no domínio. A API responde 503 com `Retry-After`.
 */
export class ServiceUnavailableError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfterSeconds: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ServiceUnavailableError';
  }
}
