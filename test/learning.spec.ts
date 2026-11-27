import { BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Types } from 'mongoose';
import { LearningContentService } from '../src/modules/learning/application/learning-content.service';
import { LearningService } from '../src/modules/learning/application/learning.service';
import { ModuleAccessService } from '../src/modules/module-access/application/module-access.service';
import { ModuleProgressPort, UnintegratedModuleProgress } from '../src/modules/module-access/application/module-progress';
import { MAX_SECTIONS, unlockedModules, validBlock, validCourse, validLesson, validModule } from '../src/modules/learning/domain/learning';
import { courseFixture, lessonFixture, moduleFixture, sampleBlocks } from './learning-fixtures';

describe('Dominio del contenido educativo', () => {
  it('acepta los seis tipos de bloque aprobados', () => {
    expect(sampleBlocks().map((b) => b.tipo)).toEqual(['titulo', 'parrafo', 'lista', 'tabla', 'destacado', 'recurso']);
    expect(sampleBlocks().every(validBlock)).toBe(true);
    for (const recurso of ['flashcards', 'cuestionario', 'simulador']) expect(validBlock({ tipo: 'recurso', recurso })).toBe(true);
  });
  it.each([
    ['tipo desconocido', { tipo: 'video', texto: 'x' }],
    ['campo extra', { tipo: 'parrafo', texto: 'x', html: '<b>' }],
    ['texto vacío', { tipo: 'titulo', texto: '  ' }],
    ['lista vacía', { tipo: 'lista', ordenada: false, items: [] }],
    ['lista sin booleano', { tipo: 'lista', ordenada: 'si', items: ['a'] }],
    ['fila con otra cantidad de celdas', { tipo: 'tabla', encabezados: ['a', 'b'], filas: [['1']] }],
    ['variante desconocida', { tipo: 'destacado', variante: 'peligro', texto: 'x' }],
    ['recurso desconocido', { tipo: 'recurso', recurso: 'video' }],
    ['no es objeto', 'parrafo'],
  ])('rechaza bloque inválido: %s', (_name, block) => expect(validBlock(block)).toBe(false));
  it('valida curso, módulo y lección completos y rechaza documentos incompatibles', () => {
    const course = courseFixture(), module = moduleFixture(course._id, 1), lesson = lessonFixture(module._id, 1);
    expect(validCourse(course) && validModule(module) && validLesson(lesson)).toBe(true);
    expect(validCourse({ ...course, estado: 'archivado' })).toBe(false);
    expect(validCourse({ ...course, proyectoFinal: undefined })).toBe(false);
    expect(validModule({ ...module, orden: 0 })).toBe(false);
    expect(validModule({ ...module, orden: 1.5 })).toBe(false);
    expect(validModule({ ...module, cursoId: course._id.toHexString() })).toBe(false);
    expect(validLesson({ ...lesson, secciones: [] })).toBe(false);
    expect(validLesson({ ...lesson, secciones: Array.from({ length: MAX_SECTIONS + 1 }, () => ({ tipo: 'parrafo', texto: 'x' })) })).toBe(false);
    expect(validLesson({ ...lesson, secciones: [{ tipo: 'otro' }] })).toBe(false);
    expect(validLesson({ ...lesson, version: 0 })).toBe(false);
  });
});

describe('Regla de avance secuencial', () => {
  const course = courseFixture();
  const modules = [1, 2, 3, 4, 5].map((orden) => moduleFixture(course._id, orden));
  const id = (orden: number) => modules[orden - 1]._id.toHexString();
  it('solo el primer módulo está abierto sin progreso', () => expect([...unlockedModules(modules, new Set())]).toEqual([id(1)]));
  it('abre el siguiente cuando el anterior está completado, sin saltar módulos', () => {
    expect([...unlockedModules(modules, new Set([id(1)]))]).toEqual([id(1), id(2)]);
    expect([...unlockedModules(modules, new Set([id(1), id(3)]))]).toEqual([id(1), id(2), id(4)]);
    expect([...unlockedModules(modules, new Set([id(1), id(2), id(3), id(4)]))]).toHaveLength(5);
  });
  it('un módulo completado no abre uno posterior no consecutivo', () => expect(unlockedModules(modules, new Set([id(1)])).has(id(3))).toBe(false));
  it('un predecesor inactivo o ausente cierra el siguiente y el módulo inactivo nunca se abre', () => {
    const inactive = [modules[0], { ...modules[1], activo: false }, modules[2]];
    expect([...unlockedModules(inactive, new Set([id(1), id(2)]))]).toEqual([id(1)]);
    expect([...unlockedModules([modules[0], modules[2]], new Set([id(1)]))]).toEqual([id(1)]);
    expect(unlockedModules([{ ...modules[0], activo: false }], new Set()).size).toBe(0);
  });
});

describe('LearningService', () => {
  const course = courseFixture();
  const modules = [1, 2, 3].map((orden) => moduleFixture(course._id, orden));
  const lessons = [1, 2].map((orden) => lessonFixture(modules[1]._id, orden));
  const user = new Types.ObjectId().toHexString();
  const content = {
    publishedCourses: jest.fn(), publishedCourse: jest.fn(), courseModules: jest.fn(), module: jest.fn(), activeLessons: jest.fn(), activeLesson: jest.fn(),
  };
  const progress = { completedModules: jest.fn() };
  const service = () => {
    const contentService = content as unknown as LearningContentService;
    return new LearningService(contentService, new ModuleAccessService(contentService, progress as unknown as ModuleProgressPort));
  };
  beforeEach(() => {
    jest.resetAllMocks();
    content.publishedCourse.mockImplementation(async (id: Types.ObjectId) => (id.equals(course._id) ? course : null));
    content.courseModules.mockResolvedValue(modules);
    content.module.mockImplementation(async (id: Types.ObjectId) => modules.find((m) => m._id.equals(id)) ?? null);
    content.activeLessons.mockResolvedValue(lessons);
    content.activeLesson.mockImplementation(async (id: Types.ObjectId) => lessons.find((l) => l._id.equals(id)) ?? null);
    progress.completedModules.mockResolvedValue([modules[0]._id.toHexString()]);
  });

  it('lista cursos con paginación y solo id y título', async () => {
    content.publishedCourses.mockResolvedValue({ items: [course], hayMas: true });
    expect(await service().courses({ pagina: 2, limite: 1 })).toEqual({ items: [{ id: course._id.toHexString(), titulo: course.titulo }], pagina: 2, limite: 1, hayMas: true });
    expect(content.publishedCourses).toHaveBeenCalledWith({ pagina: 2, limite: 1 });
  });
  it('detalle de curso incluye proyecto final y responde 404 si no está publicado', async () => {
    expect(await service().course(course._id.toHexString())).toEqual({ id: course._id.toHexString(), titulo: course.titulo, proyectoFinal: course.proyectoFinal });
    await expect(service().course(new Types.ObjectId().toHexString())).rejects.toBeInstanceOf(NotFoundException);
    await expect(service().course('no-es-id')).rejects.toBeInstanceOf(BadRequestException);
  });
  it('lista módulos activos en orden con disponibilidad según progreso', async () => {
    content.courseModules.mockResolvedValue([modules[0], modules[1], { ...modules[2], activo: false }]);
    const result = await service().modules(user, course._id.toHexString());
    expect(result.items).toEqual([
      { id: modules[0]._id.toHexString(), orden: 1, titulo: modules[0].titulo, disponible: true },
      { id: modules[1]._id.toHexString(), orden: 2, titulo: modules[1].titulo, disponible: true },
    ]);
    expect(progress.completedModules).toHaveBeenCalledWith(user, course._id.toHexString());
  });
  it('los módulos posteriores aparecen visibles pero no disponibles', async () => {
    const result = await service().modules(user, course._id.toHexString());
    expect(result.items.map((m) => m.disponible)).toEqual([true, true, false]);
  });
  it('no consulta progreso cuando no hay módulos posteriores al primero', async () => {
    content.courseModules.mockResolvedValue([modules[0]]);
    expect((await service().modules(user, course._id.toHexString())).items).toHaveLength(1);
    expect(progress.completedModules).not.toHaveBeenCalled();
  });
  it('el módulo 1 siempre está abierto: sirve lecciones sin consultar el progreso, aunque este falle', async () => {
    progress.completedModules.mockRejectedValue(new Error('progreso caído'));
    content.activeLessons.mockResolvedValue([lessonFixture(modules[0]._id, 1)]);
    content.activeLesson.mockResolvedValue(lessonFixture(modules[0]._id, 1));
    const list = await service().lessons(user, modules[0]._id.toHexString());
    expect(list.items).toHaveLength(1);
    expect((await service().lesson(user, new Types.ObjectId().toHexString())).moduloId).toBe(modules[0]._id.toHexString());
    expect(progress.completedModules).not.toHaveBeenCalled();
    await expect(service().lessons(user, modules[1]._id.toHexString())).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it('el módulo 1 sigue exigiendo curso publicado y módulo activo', async () => {
    content.module.mockResolvedValue({ ...modules[0], activo: false });
    await expect(service().lessons(user, modules[0]._id.toHexString())).rejects.toBeInstanceOf(NotFoundException);
    content.module.mockResolvedValue(modules[0]); content.publishedCourse.mockResolvedValue(null);
    await expect(service().lessons(user, modules[0]._id.toHexString())).rejects.toBeInstanceOf(NotFoundException);
  });
  it('curso no publicado: 404 en módulos y lecciones', async () => {
    await expect(service().modules(user, new Types.ObjectId().toHexString())).rejects.toBeInstanceOf(NotFoundException);
    content.publishedCourse.mockResolvedValue(null);
    await expect(service().lessons(user, modules[1]._id.toHexString())).rejects.toBeInstanceOf(NotFoundException);
    await expect(service().lesson(user, lessons[0]._id.toHexString())).rejects.toBeInstanceOf(NotFoundException);
  });
  it('módulo inactivo o inexistente: 404', async () => {
    content.module.mockResolvedValue({ ...modules[1], activo: false });
    await expect(service().lessons(user, modules[1]._id.toHexString())).rejects.toBeInstanceOf(NotFoundException);
    content.module.mockResolvedValue(null);
    await expect(service().lessons(user, modules[1]._id.toHexString())).rejects.toBeInstanceOf(NotFoundException);
  });
  it('módulo bloqueado: 403 y no revela lecciones', async () => {
    await expect(service().lessons(user, modules[2]._id.toHexString())).rejects.toBeInstanceOf(ForbiddenException);
    expect(content.activeLessons).not.toHaveBeenCalled();
    content.activeLesson.mockResolvedValue(lessonFixture(modules[2]._id, 1));
    await expect(service().lesson(user, new Types.ObjectId().toHexString())).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('lista y consulta lecciones de un módulo disponible', async () => {
    expect(await service().lessons(user, modules[1]._id.toHexString())).toEqual({ moduloId: modules[1]._id.toHexString(), cursoId: course._id.toHexString(),
      items: lessons.map((l) => ({ id: l._id.toHexString(), orden: l.orden, titulo: l.titulo, version: 1 })) });
    const result = await service().lesson(user, lessons[0]._id.toHexString());
    expect(result).toMatchObject({ id: lessons[0]._id.toHexString(), moduloId: modules[1]._id.toHexString(), orden: 1, version: 1 });
    expect(result.secciones.map((s) => s.tipo)).toEqual(['titulo', 'parrafo', 'lista', 'tabla', 'destacado', 'recurso']);
  });
  it('los recursos se reportan no operativos mientras su servicio no esté conectado', async () => {
    content.activeLesson.mockResolvedValue({ ...lessons[0], secciones: [{ tipo: 'recurso', recurso: 'simulador' }, { tipo: 'recurso', recurso: 'cuestionario' }, { tipo: 'recurso', recurso: 'flashcards' }] });
    const result = await service().lesson(user, lessons[0]._id.toHexString());
    expect(result.secciones).toEqual([{ tipo: 'recurso', recurso: 'simulador', operativo: false }, { tipo: 'recurso', recurso: 'cuestionario', operativo: false }, { tipo: 'recurso', recurso: 'flashcards', operativo: true }]);
  });
  it('lección inexistente o inactiva: 404 y ids inválidos: 400', async () => {
    content.activeLesson.mockResolvedValue(null);
    await expect(service().lesson(user, new Types.ObjectId().toHexString())).rejects.toBeInstanceOf(NotFoundException);
    await expect(service().lesson(user, '123')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service().lessons(user, '123')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service().modules(user, '123')).rejects.toBeInstanceOf(BadRequestException);
  });
  it('ignora ids de progreso que no pertenecen al curso', async () => {
    progress.completedModules.mockResolvedValue([new Types.ObjectId().toHexString()]);
    expect((await service().modules(user, course._id.toHexString())).items.map((m) => m.disponible)).toEqual([true, false, false]);
  });
  it('un fallo o contrato inválido de progreso nunca abre ni cierra módulos: 503', async () => {
    progress.completedModules.mockRejectedValue(new Error('caído'));
    await expect(service().modules(user, course._id.toHexString())).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service().lessons(user, modules[1]._id.toHexString())).rejects.toBeInstanceOf(ServiceUnavailableException);
    progress.completedModules.mockResolvedValue(['no-es-objectid']);
    await expect(service().modules(user, course._id.toHexString())).rejects.toBeInstanceOf(ServiceUnavailableException);
    progress.completedModules.mockResolvedValue(null);
    await expect(service().modules(user, course._id.toHexString())).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it('un fallo de almacenamiento o contenido incompatible produce 503 sanitizado', async () => {
    content.publishedCourse.mockRejectedValue(new Error('mongodb://secreto'));
    const error = await service().course(course._id.toHexString()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify((error as ServiceUnavailableException).getResponse())).not.toMatch(/mongodb|secreto/);
  });
  it('el proveedor de progreso por defecto responde 503', async () => {
    await expect(new UnintegratedModuleProgress().completedModules(user, course._id.toHexString())).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it('con el proveedor de progreso por defecto, el módulo 1 funciona y los siguientes responden 503', async () => {
    content.activeLessons.mockResolvedValue([lessonFixture(modules[0]._id, 1)]);
    content.activeLesson.mockResolvedValue(lessonFixture(modules[0]._id, 1));
    const contentService = content as unknown as LearningContentService;
    const unintegrated = new LearningService(contentService, new ModuleAccessService(contentService, new UnintegratedModuleProgress()));
    expect((await unintegrated.lessons(user, modules[0]._id.toHexString())).items).toHaveLength(1);
    expect((await unintegrated.lesson(user, new Types.ObjectId().toHexString())).moduloId).toBe(modules[0]._id.toHexString());
    await expect(unintegrated.lessons(user, modules[1]._id.toHexString())).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it('el progreso de un estudiante no abre módulos a otro', async () => {
    const other = new Types.ObjectId().toHexString();
    progress.completedModules.mockImplementation(async (student: string) => (student === user ? [modules[0]._id.toHexString()] : []));
    expect((await service().modules(user, course._id.toHexString())).items.map((m) => m.disponible)).toEqual([true, true, false]);
    expect((await service().modules(other, course._id.toHexString())).items.map((m) => m.disponible)).toEqual([true, false, false]);
    await expect(service().lessons(user, modules[1]._id.toHexString())).resolves.toMatchObject({ moduloId: modules[1]._id.toHexString() });
    await expect(service().lessons(other, modules[1]._id.toHexString())).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('LearningContentService: secuencia de módulos', () => {
  const course = courseFixture();
  const read = (found: unknown[]) => {
    const model = { find: () => ({ sort: () => ({ lean: async () => found }) }) };
    return new LearningContentService({} as never, model as never, {} as never).courseModules(course._id);
  };
  it('acepta órdenes distintos', async () => {
    await expect(read([moduleFixture(course._id, 1), moduleFixture(course._id, 2)])).resolves.toHaveLength(2);
  });
  it.each([
    ['dos módulos activos con orden 1', [1, 1], true],
    ['un orden posterior repetido', [1, 2, 2], true],
    ['un duplicado inactivo', [1, 1], false],
  ])('rechaza %s', async (_name, orders, activo) => {
    const found = orders.map((orden, i) => moduleFixture(course._id, orden, { activo: activo || i === 0 }));
    await expect(read(found)).rejects.toThrow('Contenido educativo incompatible');
  });
});
