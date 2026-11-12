// Limites do pedido num lugar só, para o domínio e a validação de entrada usarem os mesmos números.
// Os tamanhos de texto acompanham as colunas da tabela (ver docs/schema.sql).
export const ORDER_RULES = {
  minItems: 1,
  maxItems: 20,
  minQuantity: 1,
  maxQuantity: 999,
  minUnitPrice: 0.01,
  // com 20 itens x 999 unidades o total ainda cabe com folga no DECIMAL(12,2)
  maxUnitPrice: 100_000,
  customerNameMin: 2,
  customerNameMax: 120,
  customerEmailMax: 160,
  notesMax: 500,
  productIdMax: 64,
  productNameMax: 160,
} as const;

// Validação simples de e-mail: algo@algo.algo, sem espaços. Não tenta cobrir a RFC inteira.
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
