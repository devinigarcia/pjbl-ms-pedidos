// Erros do domínio. A camada de API traduz cada tipo para um status HTTP:
// ValidationError -> 400, NotFoundError -> 404, ConflictError -> 409, DomainError -> 422.

export interface FieldError {
  field: string;
  message: string;
}

/** Regra de negócio violada (vira 422 na API). */
export class DomainError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

/** Entrada com formato inválido (vira 400, com a lista de campos em `details`). */
export class ValidationError extends DomainError {
  constructor(details: FieldError[], message = 'Dados inválidos.') {
    super('VALIDATION_ERROR', message, details);
  }
}

/** Recurso que não existe (vira 404). */
export class NotFoundError extends DomainError {}

/** Operação que conflita com o estado atual do recurso (vira 409). */
export class ConflictError extends DomainError {}
