import { Module } from '@nestjs/common';
import { AccessControlModule } from '../auth/access-control.module';
import { LearningService } from './application/learning.service';
import { ModuleProgressPort, UnintegratedModuleProgress } from './application/module-progress';
import { LearningContentModule } from './learning-content.module';
import { LearningController } from './presentation/learning.controller';

/** Student-facing educational reads. The progress provider is replaced when the progress module is integrated. */
@Module({
  imports: [AccessControlModule, LearningContentModule],
  controllers: [LearningController],
  providers: [LearningService, { provide: ModuleProgressPort, useClass: UnintegratedModuleProgress }],
})
export class LearningModule {}
