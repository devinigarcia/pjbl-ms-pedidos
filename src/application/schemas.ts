import { z } from 'zod';
import { ORDER_RULES } from '../domain/order/OrderRules';

// Pedaços de schema usados por mais de uma feature (uma feature não importa a outra,
// então o que é comum fica aqui).

export const customerNameSchema = z
  .string()
  .trim()
  .min(ORDER_RULES.customerNameMin)
  .max(ORDER_RULES.customerNameMax);

export const customerEmailSchema = z.string().trim().toLowerCase().max(ORDER_RULES.customerEmailMax).email();

/** Observação é opcional: ausente, `null` ou texto vazio significam "sem observação". */
export const notesSchema = z.string().trim().max(ORDER_RULES.notesMax).nullish();

/** Parâmetro de consulta opcional: `?campo=` (vazio) conta como não informado. */
export function emptyAsUndefined(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? undefined : value;
}
