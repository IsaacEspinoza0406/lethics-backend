import { Types } from 'mongoose';
import { CourseProject } from '../src/modules/projects/application/project-ports';

/** Synthetic contract policy only: NOT a confirmation of Lethics academic limits. */
export function projectFixture(cursoId = new Types.ObjectId().toString()): CourseProject {
  return { cursoId, instrucciones: 'Instrucciones sintéticas del proyecto.', politica: {
    maxEntregas: 3, maxEnlaces: 3, hostsEnlace: ['example.test'], maxArchivos: 2,
    formatosArchivo: ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], maxArchivoBytes: 10 * 1024 * 1024,
  } };
}
