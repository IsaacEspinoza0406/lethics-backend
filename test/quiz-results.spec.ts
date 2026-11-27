import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { Connection, Model, Types } from 'mongoose';
import { AssessmentsService } from '../src/modules/assessments/application/assessments.service';
import { AssessmentResultsPort, UnintegratedAssessmentContext } from '../src/modules/assessments/application/assessment-context';
import { Attempt, Evaluation } from '../src/modules/assessments/domain/assessment';
import { QuizResultRecord, quizResultFixture } from './quiz-results-fixtures';

describe('AssessmentResultsPort.quizResults: resumen privado de intentos válidos', () => {
  const user = new Types.ObjectId(), course = new Types.ObjectId(), moduleId = new Types.ObjectId();
  const fixture = (correct = 7, overrides: Partial<Attempt> = {}) => quizResultFixture(correct, { usuarioId: user, cursoId: course, moduloId: moduleId, ...overrides });
  let records: QuizResultRecord[], streamFailure: boolean;
  let service: AssessmentResultsPort;
  const close = jest.fn(async () => undefined), aggregate = jest.fn();
  const listCollections = jest.fn();
  beforeEach(() => {
    jest.clearAllMocks(); records = []; streamFailure = false;
    listCollections.mockReturnValue({ toArray: async () => [{ name: 'evaluaciones' }, { name: 'intentos_evaluacion' }] });
    aggregate.mockImplementation(() => ({ cursor: () => ({
      async *[Symbol.asyncIterator]() { for (const record of records) yield record; if (streamFailure) throw new Error('synthetic-private-driver-error'); }, close,
    }) }));
    service = new AssessmentsService({ readyState: 1, db: { listCollections } } as unknown as Connection,
      {} as Model<Evaluation>, { aggregate } as unknown as Model<Attempt>, new UnintegratedAssessmentContext());
  });
  const read = () => service.quizResults(user.toHexString(), course.toHexString());
  it('sin intentos devuelve [] y cierra el cursor', async () => {
    await expect(read()).resolves.toEqual([]); expect(close).toHaveBeenCalledTimes(1);
  });
  it.each([6, 7])('un intento con %s aciertos devuelve solo módulo y aprobación', async correct => {
    records = [fixture(correct)];
    await expect(read()).resolves.toEqual([{ moduloId: moduleId.toHexString(), aprobado: correct >= 7 }]);
  });
  it('agrupa intentos repetidos, sin convertir presentación en aprobación', async () => {
    records = [fixture(4), fixture(6), fixture(1)];
    await expect(read()).resolves.toEqual([{ moduloId: moduleId.toHexString(), aprobado: false }]);
  });
  it('conserva aprobación si existe al menos un aprobado, aunque después repruebe', async () => {
    records = [fixture(6), fixture(7), fixture(3)];
    await expect(read()).resolves.toEqual([{ moduloId: moduleId.toHexString(), aprobado: true }]);
  });
  it('agrega distintas evaluaciones/versiones históricas del mismo módulo', async () => {
    records = [fixture(6), fixture(8, { version: 2 }), fixture(2, { version: 3 })];
    await expect(read()).resolves.toEqual([{ moduloId: moduleId.toHexString(), aprobado: true }]);
  });
  it('excluye examen final, incluso si un documento falso declara un módulo', async () => {
    const final = fixture(10); final.evaluacion.tipo = 'examen_final';
    records = [fixture(10, { moduloId: null }), final];
    await expect(read()).resolves.toEqual([]);
    expect(aggregate.mock.calls[0][0]).toContainEqual({ $match: { 'evaluacion.tipo': 'cuestionario' } });
  });
  it('aísla estudiantes y cursos tanto en el filtro MongoDB como al validar registros', async () => {
    records = [fixture(6), fixture(10, { usuarioId: new Types.ObjectId() }), fixture(10, { cursoId: new Types.ObjectId() })];
    await expect(read()).resolves.toEqual([{ moduloId: moduleId.toHexString(), aprobado: false }]);
    expect(aggregate.mock.calls[0][0][0]).toEqual({ $match: { usuarioId: user, cursoId: course, moduloId: { $type: 'objectId' } } });
  });
  it.each(['incomplete', 'duplicate', 'question', 'option', 'grade', 'date', 'request', 'version', 'module', 'course', 'evaluation'] as const)('excluye intento inválido: %s', async kind => {
    const record = fixture(10);
    if (kind === 'incomplete') record.respuestas.pop();
    if (kind === 'duplicate') record.respuestas[1] = record.respuestas[0];
    if (kind === 'question') record.respuestas[0].preguntaId = 'unknown';
    if (kind === 'option') record.respuestas[0].opcionId = 'unknown';
    if (kind === 'grade') record.respuestas[0].opcionId = 'b';
    if (kind === 'date') record.fecha = new Date(NaN);
    if (kind === 'request') record.solicitudId = '';
    if (kind === 'version') record.version = 2;
    if (kind === 'module') record.moduloId = new Types.ObjectId();
    if (kind === 'course') record.evaluacion.cursoId = new Types.ObjectId();
    if (kind === 'evaluation') record.evaluacionId = new Types.ObjectId();
    records = [record]; await expect(read()).resolves.toEqual([]);
  });
  it('no cambia los intentos ni revela respuestas, preguntas o notas individuales', async () => {
    records = [fixture(7)]; const before = JSON.stringify(records);
    const result = await read();
    expect(Object.keys(result[0]).sort()).toEqual(['aprobado', 'moduloId']);
    expect(JSON.stringify(records)).toBe(before);
  });
  it('ordena por ID para proporcionar resultados deterministas', async () => {
    const second = new Types.ObjectId(); records = [fixture(6, { moduloId: second }), fixture(7)];
    expect((await read()).map(result => result.moduloId)).toEqual([moduleId.toHexString(), second.toHexString()].sort());
  });
  it('fallo de MongoDB al preparar la consulta se propaga como 503', async () => {
    listCollections.mockImplementationOnce(() => { throw new Error('synthetic-private-storage-error'); });
    await expect(read()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it('fallo del cursor tras leer un aprobado rechaza todo; no entrega [] ni resultados parciales', async () => {
    records = [fixture(10)]; streamFailure = true;
    const error = await read().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify((error as ServiceUnavailableException).getResponse())).not.toContain('synthetic-private');
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('un fallo al cerrar el cursor también se propaga', async () => {
    close.mockRejectedValueOnce(new Error('synthetic-private-close'));
    await expect(read()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it('rechaza identificadores inválidos antes de consultar', async () => {
    await expect(service.quizResults('invalid', course.toString())).rejects.toBeInstanceOf(BadRequestException);
    expect(aggregate).not.toHaveBeenCalled();
  });
  it('conserva el contrato y la consulta existente hasPassedFinalExam', async () => {
    records = [fixture(6)]; await read();
    aggregate.mockReturnValueOnce([]).mockReturnValueOnce([{ _id: new Types.ObjectId() }]);
    await expect(service.hasPassedFinalExam(user.toString(), course.toString())).resolves.toBe(false);
    await expect(service.hasPassedFinalExam(user.toString(), course.toString())).resolves.toBe(true);
    expect(aggregate.mock.calls[1][0][0]).toEqual({ $match: { usuarioId: user, cursoId: course, moduloId: null, aprobado: true, porcentaje: { $gte: 70 } } });
  });
});
