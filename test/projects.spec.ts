import mongoose, { Types } from 'mongoose';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { canonicalEvidence, canonicalLink, ProjectSubmission, submissionSlot, validPolicy } from '../src/modules/projects/domain/project';
import { ProjectSchema } from '../src/modules/projects/infrastructure/project.schema';
import { SubmitProjectDto } from '../src/modules/projects/presentation/project.dto';
import { UnconfiguredProjectFiles, UnintegratedProjectCourse } from '../src/modules/projects/application/project-ports';
import { projectFixture } from './project-fixtures';

describe('Proyecto: contratos de evidencia y política sin valores académicos predeterminados', () => {
  const Model = mongoose.model<ProjectSubmission>('ProjectUnit', ProjectSchema);
  afterAll(() => mongoose.deleteModel('ProjectUnit'));
  it('valida política explícita de fixture y no admite configuración incompleta', () => {
    expect(validPolicy(projectFixture().politica)).toBe(true);
    for (const patch of [{ maxEntregas: 0 }, { maxEntregas: undefined }, { maxEnlaces: -1 }, { maxArchivos: 21 }, { maxArchivoBytes: -1 }, { formatosArchivo: [] }, { hostsEnlace: [] }]) expect(validPolicy({ ...projectFixture().politica, ...patch } as never)).toBe(false);
  });
  it('normaliza HTTPS sin buscar ni descargar el contenido remoto', () => {
    expect(canonicalLink('https://EXAMPLE.test:443/proyecto')).toBe('https://example.test/proyecto');
    expect(canonicalEvidence([{ tipo: 'enlace', url: 'https://example.test/b' }, { tipo: 'enlace', url: 'https://example.test/a' }])).toEqual(canonicalEvidence([{ tipo: 'enlace', url: 'https://example.test/a' }, { tipo: 'enlace', url: 'https://example.test/b' }]));
  });
  it.each(['http://example.test/a', 'file:///private', 'javascript:alert(1)', 'https://localhost/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'https://user:secret@example.test/a', 'https://example.test:8080/a', 'https://example.test/a#fragment', 'https://example.test/a b', 'https://example.test/\\a'])('rechaza enlace inseguro: %s', (url) => {
    expect(() => canonicalLink(url)).toThrow();
  });
  it('rechaza duplicados canónicos, evidencias vacías o combinaciones arbitrarias', () => {
    for (const values of [[], [{ tipo: 'enlace', url: 'https://example.test/' }, { tipo: 'enlace', url: 'https://EXAMPLE.test/' }], [{ tipo: 'archivo', referencia: '../privado' }], [{ tipo: 'archivo', referencia: 'file1', bytes: 1 }], [{ tipo: 'enlace', url: 'https://example.test/', referencia: 'file1' }]]) expect(() => canonicalEvidence(values as never)).toThrow();
  });
  it('crea modelo acotado con referencias ObjectId y no permite estados del cliente', async () => {
    const valid = { usuarioId: new Types.ObjectId(), cursoId: new Types.ObjectId(), solicitudId: 'fixture', fechaEntrega: new Date(), estado: 'registrada', evidencias: [{ tipo: 'enlace', url: 'https://example.test/' }] };
    await expect(new Model(valid).validate()).resolves.toBeUndefined();
    for (const patch of [{ estado: 'aprobada' }, { evidencias: [] }, { evidencias: [{ tipo: 'archivo', referencia: 'fake' }] }, { usuarioId: 'conceptual-id' }]) await expect(new Model({ ...valid, ...patch }).validate()).rejects.toThrow();
    expect(() => new Model({ ...valid, valida: true })).toThrow();
    expect(ProjectSchema.options.autoIndex).toBe(false); expect(ProjectSchema.options.autoCreate).toBe(false);
  });
  it('DTO no acepta metadatos, identidad, estado ni validación declarados por frontend', async () => {
    const check = (value: unknown) => validate(plainToInstance(SubmitProjectDto, value), { whitelist: true, forbidNonWhitelisted: true });
    const input = { solicitudId: 'fixture', evidencias: [{ tipo: 'enlace', url: 'https://example.test/' }] };
    expect(await check(input)).toHaveLength(0);
    expect(canonicalEvidence(plainToInstance(SubmitProjectDto, input).evidencias as never)).toEqual(input.evidencias);
    for (const patch of [{ usuarioId: new Types.ObjectId().toString() }, { cursoId: new Types.ObjectId().toString() }, { estado: 'registrada' }, { valida: true }, { solicitudId: '' }, { evidencias: [{ tipo: 'archivo', referencia: 'file1', mime: 'application/pdf', bytes: 1 }] }, { evidencias: Array(21).fill(input.evidencias[0]) }]) expect(await check({ ...input, ...patch })).not.toHaveLength(0);
  });
  it('cupo estable por estudiante/curso sin depender de solicitud ni instancia', () => {
    const user = new Types.ObjectId(), course = new Types.ObjectId();
    expect(submissionSlot(user, course, 1)).toEqual(submissionSlot(user, course, 1));
    expect(submissionSlot(user, course, 2)).not.toEqual(submissionSlot(user, course, 1));
    expect(submissionSlot(new Types.ObjectId(), course, 1)).not.toEqual(submissionSlot(user, course, 1));
    expect(() => submissionSlot(user, course, 0)).toThrow();
  });
  it('proveedores de cursos y archivos no configurados fallan cerrado', async () => {
    const owner = { usuarioId: new Types.ObjectId().toString(), cursoId: new Types.ObjectId().toString() };
    await expect(new UnintegratedProjectCourse().describe(owner)).rejects.toThrow();
    await expect(new UnconfiguredProjectFiles().verify(owner, 'file1')).rejects.toThrow();
  });
});
