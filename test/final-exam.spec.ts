import { Types } from 'mongoose';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AssessmentContextPort, UnintegratedAssessmentContext } from '../src/modules/assessments/application/assessment-context';
import { finalAttemptId } from '../src/modules/assessments/domain/final-exam';
import { EvaluationListDto, EvaluationScopeDto, HistoryDto } from '../src/modules/assessments/presentation/assessment.dto';

describe('Examen final: contratos y cupos persistentes', () => {
  const user = new Types.ObjectId(), course = new Types.ObjectId();
  it('deriva un ObjectId estable por estudiante, curso y posición, independiente de versión/solicitud', () => {
    expect(finalAttemptId(user, course, 1)).toBeInstanceOf(Types.ObjectId);
    expect(finalAttemptId(user, course, 1)).toEqual(finalAttemptId(user, course, 1));
    expect(new Set([1, 2, 3].map((slot) => finalAttemptId(user, course, slot).toHexString())).size).toBe(3);
    expect(finalAttemptId(new Types.ObjectId(), course, 1)).not.toEqual(finalAttemptId(user, course, 1));
    expect(finalAttemptId(user, new Types.ObjectId(), 1)).not.toEqual(finalAttemptId(user, course, 1));
  });
  it.each([0, 4, -1, 1.5, NaN])('no genera cupos fuera de 1..3: %s', (slot) => {
    expect(() => finalAttemptId(user, course, slot)).toThrow('Cupo inválido');
  });
  it('extiende adaptadores de A1 sin habilitar finales por defecto', async () => {
    class QuizOnly extends AssessmentContextPort { async isAvailable() { return true; } }
    const descriptor = { usuarioId: user.toString(), cursoId: course.toString(), evaluacionId: new Types.ObjectId().toString(), moduloId: null, version: 1 } as const;
    await expect(new QuizOnly().finalExamEligibility(descriptor)).rejects.toThrow('Integración de progreso y entregas pendiente.');
    await expect(new UnintegratedAssessmentContext().finalExamEligibility(descriptor)).rejects.toThrow();
  });
  it('valida filtros finales sin romper la consulta por módulo', async () => {
    const check = (value: unknown) => validate(plainToInstance(EvaluationListDto, value), { whitelist: true, forbidNonWhitelisted: true });
    expect(await check({ moduloId: new Types.ObjectId().toString() })).toHaveLength(0);
    expect(await check({ tipo: 'examen_final', cursoId: course.toString() })).toHaveLength(0);
    for (const input of [{ tipo: 'examen_final' }, { tipo: 'examen_final', cursoId: 'incorrecto' }, { tipo: 'otro', moduloId: course.toString() }, { completado: true }, { proyectoEntregado: true }]) expect(await check(input)).not.toHaveLength(0);
    expect(await validate(plainToInstance(EvaluationScopeDto, { cursoId: course.toString() }))).toHaveLength(0);
    expect(await validate(plainToInstance(HistoryDto, { cursoId: 'incorrecto' }))).not.toHaveLength(0);
  });
});
