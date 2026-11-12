import { z } from 'zod';
import { ValidationError, type FieldError } from '../domain/errors';

const TYPE_NAMES: Record<string, string> = {
  string: 'texto',
  number: 'número',
  integer: 'número inteiro',
  boolean: 'verdadeiro/falso',
  array: 'lista',
  object: 'objeto',
};

// Traduz as mensagens padrão do zod. Mensagens escritas direto no schema continuam valendo.
const portugueseErrorMap: z.ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      if (issue.received === 'undefined' || issue.received === 'null') {
        return { message: 'Campo obrigatório.' };
      }
      return { message: `Tipo inválido: esperado ${TYPE_NAMES[issue.expected] ?? issue.expected}.` };

    case z.ZodIssueCode.too_small:
      if (issue.type === 'string') {
        return {
          message:
            issue.minimum === 1 ? 'Não pode ficar vazio.' : `Deve ter pelo menos ${issue.minimum} caracteres.`,
        };
      }
      if (issue.type === 'array') {
        return { message: `Deve ter pelo menos ${issue.minimum} item(ns).` };
      }
      return { message: issue.inclusive ? `Deve ser no mínimo ${issue.minimum}.` : `Deve ser maior que ${issue.minimum}.` };

    case z.ZodIssueCode.too_big:
      if (issue.type === 'string') {
        return { message: `Deve ter no máximo ${issue.maximum} caracteres.` };
      }
      if (issue.type === 'array') {
        return { message: `Deve ter no máximo ${issue.maximum} itens.` };
      }
      return { message: issue.inclusive ? `Deve ser no máximo ${issue.maximum}.` : `Deve ser menor que ${issue.maximum}.` };

    case z.ZodIssueCode.invalid_string:
      return { message: issue.validation === 'email' ? 'E-mail inválido.' : 'Formato inválido.' };

    case z.ZodIssueCode.invalid_enum_value:
      return { message: `Valor inválido. Use um destes: ${issue.options.join(', ')}.` };

    case z.ZodIssueCode.not_finite:
      return { message: 'Deve ser um número válido.' };

    default:
      return { message: ctx.defaultError };
  }
};

/**
 * Valida a entrada de um caso de uso. Se algo estiver errado, lança ValidationError
 * com a lista `{ field, message }` que a API devolve em `error.details`.
 */
export function validate<TSchema extends z.ZodTypeAny>(schema: TSchema, input: unknown): z.infer<TSchema> {
  const result = schema.safeParse(input ?? {}, { errorMap: portugueseErrorMap });
  if (result.success) {
    return result.data;
  }

  const details: FieldError[] = result.error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : 'body',
    message: issue.message,
  }));
  throw new ValidationError(details);
}
