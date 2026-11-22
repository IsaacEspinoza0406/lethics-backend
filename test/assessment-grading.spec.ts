import { calculateGrade } from '../src/modules/assessments/domain/grading';

describe('Calificación determinista con umbral aprobado del 70%', () => {
  it.each([
    [0, 10, 0, false],
    [6, 10, 60, false],
    [7, 10, 70, true],
    [10, 10, 100, true],
    [2, 3, (2 / 3) * 100, false],
    [5, 7, (5 / 7) * 100, true],
    [69, 100, 69, false],
  ])('%i aciertos de %i preguntas', (aciertos, total, porcentaje, aprobado) => {
    expect(calculateGrade(aciertos, total)).toEqual({ aciertos, total, porcentaje, aprobado });
    expect(calculateGrade(aciertos, total)).toEqual(calculateGrade(aciertos, total));
  });

  it.each([[0, 0], [-1, 10], [11, 10], [1.5, 10], [1, 2.5], [NaN, 10], [1, Infinity], [1, Number.MAX_SAFE_INTEGER + 1]])('rechaza contadores inválidos: %s/%s', (aciertos, total) => {
    expect(() => calculateGrade(aciertos, total)).toThrow('Resultado de evaluación inválido');
  });
});
