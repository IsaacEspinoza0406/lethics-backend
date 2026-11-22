import mongoose, { Types } from 'mongoose';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { gradeAnswers, normalizeAnswers, validEvaluation } from '../src/modules/assessments/domain/assessment';
import { AttemptSchema, EvaluationSchema } from '../src/modules/assessments/infrastructure/assessment.schemas';
import { EvaluationListDto, HistoryDto, SubmitAttemptDto } from '../src/modules/assessments/presentation/assessment.dto';
import { UnintegratedAssessmentContext } from '../src/modules/assessments/application/assessment-context';
import { assessmentAnswers, assessmentFixture } from './assessment-fixtures';

describe('Contratos, modelos y corrección de cuestionarios', () => {
  const Evaluation = mongoose.model('AssessmentSchemaUnit', EvaluationSchema);
  const Attempt = mongoose.model('AttemptSchemaUnit', AttemptSchema);
  afterAll(() => { mongoose.deleteModel('AssessmentSchemaUnit'); mongoose.deleteModel('AttemptSchemaUnit'); });
  it('respeta el contrato aprobado y calcula sin confiar en porcentajes del cliente', async () => {
    const data = assessmentFixture(); expect(validEvaluation(data)).toBe(true);
    await expect(new Evaluation(data).validate()).resolves.toBeUndefined();
    expect(gradeAnswers(data.preguntas, assessmentAnswers(7))).toEqual({ aciertos: 7, total: 10, porcentaje: 70, aprobado: true });
    expect(gradeAnswers(data.preguntas, assessmentAnswers(6)).aprobado).toBe(false);
    expect(normalizeAnswers(assessmentAnswers())).toEqual(normalizeAnswers(assessmentAnswers().reverse()));
  });
  it.each(['incomplete', 'duplicate', 'question', 'option'] as const)('rechaza respuestas %s', (kind) => {
    const answers = assessmentAnswers();
    if (kind === 'incomplete') answers.pop();
    if (kind === 'duplicate') answers[1] = answers[0];
    if (kind === 'question') answers[0].preguntaId = 'unknown';
    if (kind === 'option') answers[0].opcionId = 'unknown';
    expect(() => gradeAnswers(assessmentFixture().preguntas, answers)).toThrow('Respuestas de evaluación inválidas.');
  });
  it.each(['question-id', 'option-id', 'correct-option', 'too-many-questions', 'too-many-options', 'empty', 'state', 'type', 'threshold', 'module', 'version'] as const)('rechaza estructura de evaluación inválida: %s', async (kind) => {
    const data = assessmentFixture();
    if (kind === 'question-id') data.preguntas[1].id = data.preguntas[0].id;
    if (kind === 'option-id') data.preguntas[0].opciones[1].id = 'a';
    if (kind === 'correct-option') data.preguntas[0].opcionCorrectaId = 'unknown';
    if (kind === 'too-many-questions') data.preguntas = Array.from({ length: 51 }, (_, i) => ({ ...data.preguntas[0], id: `q${i}` }));
    if (kind === 'too-many-options') data.preguntas[0].opciones = Array.from({ length: 7 }, (_, i) => ({ id: String(i), texto: 'Sintético' }));
    if (kind === 'empty') data.preguntas = [];
    if (kind === 'state') data.estado = 'archivado' as never;
    if (kind === 'type') data.tipo = 'otro' as never;
    if (kind === 'threshold') data.minimoAprobatorio = 60;
    if (kind === 'module') data.moduloId = null;
    if (kind === 'version') data.version = 0;
    expect(validEvaluation(data)).toBe(false); await expect(new Evaluation(data).validate()).rejects.toThrow();
  });
  it('modela examen final con módulo null, sin habilitar su flujo', async () => {
    await expect(new Evaluation(assessmentFixture({ tipo: 'examen_final', moduloId: null })).validate()).resolves.toBeUndefined();
    expect(validEvaluation(assessmentFixture({ tipo: 'examen_final' }))).toBe(false);
  });
  it('rechaza referencias no ObjectId y campos ajenos al modelo', async () => {
    await expect(new Evaluation({ ...assessmentFixture(), cursoId: 'curso-conceptual' }).validate()).rejects.toThrow();
    expect(() => new Evaluation({ ...assessmentFixture(), tituloNoAprobado: 'extra' })).toThrow();
    expect(EvaluationSchema.options.autoCreate).toBe(false); expect(EvaluationSchema.options.autoIndex).toBe(false);
  });
  it('valida resultado y respuestas embebidas de intentos', async () => {
    const data = { usuarioId: new Types.ObjectId(), evaluacionId: new Types.ObjectId(), cursoId: new Types.ObjectId(), moduloId: new Types.ObjectId(), version: 1, solicitudId: 'synthetic-id', respuestas: assessmentAnswers(), aciertos: 7, total: 10, porcentaje: 70, aprobado: true, fecha: new Date() };
    await expect(new Attempt(data).validate()).resolves.toBeUndefined();
    for (const invalid of [{ porcentaje: 100 }, { aprobado: false }, { respuestas: assessmentAnswers().slice(1) }, { respuestas: [assessmentAnswers()[0], ...assessmentAnswers().slice(0, 9)] }]) await expect(new Attempt({ ...data, ...invalid }).validate()).rejects.toThrow();
  });
  it('DTO valida límites, versión, identificador de solicitud y rechaza identidad/calificación del cliente', async () => {
    const input = { version: 1, solicitudId: 'synthetic-id', respuestas: assessmentAnswers() };
    const check = (value: unknown) => validate(plainToInstance(SubmitAttemptDto, value), { whitelist: true, forbidNonWhitelisted: true });
    expect(await check(input)).toHaveLength(0);
    for (const patch of [{ version: 0 }, { version: '1' }, { solicitudId: ' ' }, { respuestas: [] }, { respuestas: Array(51).fill(input.respuestas[0]) }, { respuestas: [{ preguntaId: 'q1', opcionId: 'a', correcta: true }] }, { usuarioId: new Types.ObjectId().toString() }, { porcentaje: 100 }, { aprobado: true }]) expect(await check({ ...input, ...patch })).not.toHaveLength(0);
  });
  it('paginación y filtros acotados sin usuarioId ni orden arbitrario', async () => {
    expect(await validate(plainToInstance(HistoryDto, { pagina: '2', limite: '10', orden: 'porcentaje_desc' }))).toHaveLength(0);
    for (const input of [{ limite: 51 }, { pagina: 0 }, { pagina: 10001 }, { orden: 'arbitrary' }, { evaluacionId: 'invalid' }]) expect(await validate(plainToInstance(HistoryDto, input))).not.toHaveLength(0);
    expect(await validate(plainToInstance(EvaluationListDto, {}))).not.toHaveLength(0);
  });
  it('la dependencia educativa no integrada falla cerrada', async () => { await expect(new UnintegratedAssessmentContext().isAvailable()).rejects.toThrow('Integración educativa pendiente.'); });
});
