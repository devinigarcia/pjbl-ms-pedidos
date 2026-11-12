/** Dados da requisição que os casos de uso precisam conhecer (por enquanto, só o correlation id). */
export interface RequestContext {
  correlationId: string;
}
