export interface Grade {
  aciertos: number;
  total: number;
  porcentaje: number;
  aprobado: boolean;
}

/** The approved threshold is exact; display rounding must never decide approval. */
export function calculateGrade(aciertos: number, total: number): Grade {
  if (!Number.isSafeInteger(total) || total < 1 || !Number.isSafeInteger(aciertos) || aciertos < 0 || aciertos > total) {
    throw new TypeError('Resultado de evaluación inválido');
  }
  return {
    aciertos,
    total,
    porcentaje: (aciertos / total) * 100,
    aprobado: BigInt(aciertos) * 100n >= BigInt(total) * 70n,
  };
}
