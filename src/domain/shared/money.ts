/** Arredonda para 2 casas (centavos), evitando surpresas do tipo 1.005 -> 1.00. */
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
