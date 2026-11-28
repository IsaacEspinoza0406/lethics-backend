import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LessonProgressSchema } from './infrastructure/lesson-progress.schema';
import { LessonProgressStore } from './infrastructure/lesson-progress.store';

/** Persistence-only layer of lesson progress, shared by the progress routes and the activities that complete lessons. */
@Module({
  imports: [MongooseModule.forFeature([{ name: 'ProgresoLeccion', schema: LessonProgressSchema }])],
  providers: [LessonProgressStore],
  exports: [LessonProgressStore],
})
export class ProgressDataModule {}
