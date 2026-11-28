import { Module } from '@nestjs/common';
import { AccessControlModule } from '../auth/access-control.module';
import { LearningContentModule } from '../learning/learning-content.module';
import { ModuleAccessModule } from '../module-access/module-access.module';
import { LessonProgressService } from './application/lesson-progress.service';
import { ProgressController } from './presentation/progress.controller';
import { ProgressDataModule } from './progress-data.module';

/** Student progress routes. Module gating comes from ModuleAccessModule, like the content modules. */
@Module({
  imports: [AccessControlModule, LearningContentModule, ModuleAccessModule, ProgressDataModule],
  controllers: [ProgressController],
  providers: [LessonProgressService],
})
export class ProgressModule {}
