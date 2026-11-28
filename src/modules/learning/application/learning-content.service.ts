import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Course, CourseModule, Lesson, Stored, validCourse, validLesson, validModule } from '../domain/learning';

/**
 * Read-only access to the educational content collections. It performs no authorization and no progress gating;
 * callers (the HTTP service and later the progress and integration adapters) decide who may see what.
 * Every stored document is checked against the content contract; an incompatible document throws, which the
 * callers surface as 503 instead of exposing malformed or partially trusted data.
 */
@Injectable()
export class LearningContentService {
  constructor(
    @InjectModel('Curso') private readonly courses: Model<Course>,
    @InjectModel('Modulo') private readonly modules: Model<CourseModule>,
    @InjectModel('Leccion') private readonly lessons: Model<Lesson>,
  ) {}

  private checked<T>(valid: (value: unknown) => value is T, value: unknown): T {
    if (!valid(value)) throw new Error('Contenido educativo incompatible');
    return value;
  }

  async publishedCourses(page: { pagina: number; limite: number }): Promise<{ items: Stored<Course>[]; hayMas: boolean }> {
    const found = await this.courses.find({ estado: 'publicado' }).sort({ titulo: 1, _id: 1 }).skip((page.pagina - 1) * page.limite).limit(page.limite + 1).lean();
    return { items: found.slice(0, page.limite).map((c) => this.checked(validCourse, c)), hayMas: found.length > page.limite };
  }
  async publishedCourse(id: Types.ObjectId): Promise<Stored<Course> | null> {
    const found = await this.courses.findOne({ _id: id, estado: 'publicado' }).lean();
    return found ? this.checked(validCourse, found) : null;
  }
  /**
   * All modules of the course (active or not) by `orden`: the unlock rule needs the inactive ones too.
   * A repeated `orden` makes the sequence ambiguous, so the whole course is treated as incompatible.
   */
  async courseModules(cursoId: Types.ObjectId): Promise<Stored<CourseModule>[]> {
    const found = await this.modules.find({ cursoId }).sort({ orden: 1, _id: 1 }).lean();
    const modules = found.map((m) => this.checked(validModule, m));
    if (new Set(modules.map((m) => m.orden)).size !== modules.length) throw new Error('Contenido educativo incompatible');
    return modules;
  }
  async module(id: Types.ObjectId): Promise<Stored<CourseModule> | null> {
    const found = await this.modules.findOne({ _id: id }).lean();
    return found ? this.checked(validModule, found) : null;
  }
  /** Active lessons of the module ordered by `orden`. Inactive lessons are never returned. */
  async activeLessons(moduloId: Types.ObjectId): Promise<Stored<Lesson>[]> {
    const found = await this.lessons.find({ moduloId, activo: true }).sort({ orden: 1, _id: 1 }).lean();
    return found.map((l) => this.checked(validLesson, l));
  }
  async activeLesson(id: Types.ObjectId): Promise<Stored<Lesson> | null> {
    const found = await this.lessons.findOne({ _id: id, activo: true }).lean();
    return found ? this.checked(validLesson, found) : null;
  }
}
