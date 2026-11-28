import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LearningContentService } from './application/learning-content.service';
import { CourseSchema, LessonSchema, ModuleSchema } from './infrastructure/learning.schemas';

/**
 * Read-only content layer (cursos, modulos, lecciones). It has no dependency on progress or assessments so that
 * the progress module and the cross-module adapters can import it without creating a module cycle.
 */
@Module({
  imports: [MongooseModule.forFeature([{ name: 'Curso', schema: CourseSchema }, { name: 'Modulo', schema: ModuleSchema }, { name: 'Leccion', schema: LessonSchema }])],
  providers: [LearningContentService],
  exports: [LearningContentService],
})
export class LearningContentModule {}
