import { Module } from '@nestjs/common';
import { LearningContentModule } from '../learning/learning-content.module';
import { ModuleAccessService } from './application/module-access.service';
import { ModuleProgressPort, UnintegratedModuleProgress } from './application/module-progress';

/**
 * Sequential-access rule shared by the content modules. The progress provider is replaced here when the progress
 * module is integrated; it depends only on the read-only content layer, so it creates no module cycle.
 */
@Module({
  imports: [LearningContentModule],
  providers: [ModuleAccessService, { provide: ModuleProgressPort, useClass: UnintegratedModuleProgress }],
  exports: [ModuleAccessService],
})
export class ModuleAccessModule {}
