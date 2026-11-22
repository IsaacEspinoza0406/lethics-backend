import { Types } from 'mongoose';

/** Contract of the educational content documents (collections `cursos`, `modulos`, `lecciones`). */
export const COURSE_STATES = ['borrador', 'publicado'] as const;
export type CourseState = (typeof COURSE_STATES)[number];
export const BLOCK_VARIANTS = ['nota', 'ejemplo', 'advertencia'] as const;
export const RESOURCE_KINDS = ['flashcards', 'cuestionario', 'simulador'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export const MAX_SECTIONS = 20;

export interface FinalProjectDefinition { instrucciones: string; requisitos: string[]; formatosPermitidos: string[] }
export interface Course { titulo: string; estado: CourseState; proyectoFinal: FinalProjectDefinition }
export interface CourseModule { cursoId: Types.ObjectId; orden: number; titulo: string; activo: boolean }
export type LessonBlock =
  | { tipo: 'titulo' | 'parrafo'; texto: string }
  | { tipo: 'lista'; ordenada: boolean; items: string[] }
  | { tipo: 'tabla'; encabezados: string[]; filas: string[][] }
  | { tipo: 'destacado'; variante: (typeof BLOCK_VARIANTS)[number]; texto: string }
  | { tipo: 'recurso'; recurso: ResourceKind };
export interface Lesson { moduloId: Types.ObjectId; orden: number; titulo: string; version: number; secciones: LessonBlock[]; activo: boolean }
export type Stored<T> = T & { _id: Types.ObjectId };

/**
 * Resources whose backing service is implemented and connected. A `recurso` block that is not listed here
 * is still shown (the lesson text references it) but is reported as not operational, so lessons 9 and 10
 * are not presented as working activities before the simulator or the quiz integration exists.
 * Extend only when the corresponding service is really available.
 */
export const OPERATIONAL_RESOURCES: ReadonlySet<ResourceKind> = new Set<ResourceKind>();

const isText = (value: unknown, max: number, allowEmpty = false): value is string =>
  typeof value === 'string' && value.length <= max && (allowEmpty || /\S/.test(value));
const isPositiveInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 2147483647;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => key in value);

export function validBlock(block: unknown): block is LessonBlock {
  if (!isRecord(block)) return false;
  switch (block.tipo) {
    case 'titulo': case 'parrafo': return onlyKeys(block, ['tipo', 'texto']) && isText(block.texto, 8000);
    case 'lista': return onlyKeys(block, ['tipo', 'ordenada', 'items']) && typeof block.ordenada === 'boolean' && Array.isArray(block.items) && block.items.length >= 1 && block.items.length <= 100 && block.items.every((item) => isText(item, 4000));
    case 'tabla': {
      if (!onlyKeys(block, ['tipo', 'encabezados', 'filas']) || !Array.isArray(block.encabezados) || !Array.isArray(block.filas)) return false;
      const width = block.encabezados.length;
      return width >= 1 && width <= 20 && block.filas.length >= 1 && block.filas.length <= 200 && block.encabezados.every((cell) => isText(cell, 1000, true)) &&
        block.filas.every((row) => Array.isArray(row) && row.length === width && row.every((cell) => isText(cell, 2000, true)));
    }
    case 'destacado': return onlyKeys(block, ['tipo', 'variante', 'texto']) && BLOCK_VARIANTS.includes(block.variante as never) && isText(block.texto, 8000);
    case 'recurso': return onlyKeys(block, ['tipo', 'recurso']) && RESOURCE_KINDS.includes(block.recurso as never);
    default: return false;
  }
}

export function validCourse(value: unknown): value is Stored<Course> {
  if (!isRecord(value) || !(value._id instanceof Types.ObjectId) || !isText(value.titulo, 300) || !COURSE_STATES.includes(value.estado as never)) return false;
  const project = value.proyectoFinal;
  return isRecord(project) && isText(project.instrucciones, 20000) &&
    Array.isArray(project.requisitos) && project.requisitos.length <= 50 && project.requisitos.every((item) => isText(item, 4000)) &&
    Array.isArray(project.formatosPermitidos) && project.formatosPermitidos.length <= 20 && project.formatosPermitidos.every((item) => isText(item, 100));
}
export function validModule(value: unknown): value is Stored<CourseModule> {
  return isRecord(value) && value._id instanceof Types.ObjectId && value.cursoId instanceof Types.ObjectId && isPositiveInt(value.orden) && isText(value.titulo, 300) && typeof value.activo === 'boolean';
}
export function validLesson(value: unknown): value is Stored<Lesson> {
  return isRecord(value) && value._id instanceof Types.ObjectId && value.moduloId instanceof Types.ObjectId && isPositiveInt(value.orden) && isText(value.titulo, 300) && isPositiveInt(value.version) &&
    typeof value.activo === 'boolean' && Array.isArray(value.secciones) && value.secciones.length >= 1 && value.secciones.length <= MAX_SECTIONS && value.secciones.every(validBlock);
}

/**
 * Sequential unlock rule: the first module is always open; every other module opens only once the module
 * with the immediately preceding `orden` is completed. A missing or inactive predecessor never opens it.
 */
export function unlockedModules(modules: readonly Stored<CourseModule>[], completed: ReadonlySet<string>): Set<string> {
  const byOrder = new Map(modules.map((module) => [module.orden, module]));
  const open = new Set<string>();
  for (const module of modules) {
    const previous = byOrder.get(module.orden - 1);
    if (module.activo && (module.orden === 1 || (previous?.activo === true && completed.has(previous._id.toHexString())))) open.add(module._id.toHexString());
  }
  return open;
}
