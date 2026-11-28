import { Module } from '@nestjs/common';
import { AccessControlModule } from '../auth/access-control.module';
import { ModuleAccessModule } from '../module-access/module-access.module';
import { LearningService } from './application/learning.service';
import { LearningContentModule } from './learning-content.module';
import { LearningController } from './presentation/learning.controller';

/** Student-facing educational reads (courses, modules, lessons). Module gating comes from ModuleAccessModule. */
@Module({
  imports: [AccessControlModule, LearningContentModule, ModuleAccessModule],
  controllers: [LearningController],
  providers: [LearningService],
})
export class LearningModule {}
