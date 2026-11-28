import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AccessControlModule } from '../auth/access-control.module';
import { LearningContentModule } from '../learning/learning-content.module';
import { ModuleAccessModule } from '../module-access/module-access.module';
import { LessonProgressService } from './application/lesson-progress.service';
import { LessonProgressSchema } from './infrastructure/lesson-progress.schema';
import { ProgressController } from './presentation/progress.controller';

/** Student progress. Module gating comes from ModuleAccessModule, like the content modules. */
@Module({
  imports: [AccessControlModule, LearningContentModule, ModuleAccessModule, MongooseModule.forFeature([{ name: 'ProgresoLeccion', schema: LessonProgressSchema }])],
  controllers: [ProgressController],
  providers: [LessonProgressService],
})
export class ProgressModule {}
