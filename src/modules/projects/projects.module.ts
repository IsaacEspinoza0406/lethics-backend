import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AccessControlModule } from '../auth/access-control.module';
import { ProjectCoursePort, ProjectFilePort, ProjectSubmissionPort, UnconfiguredProjectFiles, UnintegratedProjectCourse } from './application/project-ports';
import { ProjectsService } from './application/projects.service';
import { ProjectSchema } from './infrastructure/project.schema';
import { ProjectsController } from './presentation/projects.controller';

@Module({
  imports: [AccessControlModule, MongooseModule.forFeature([{ name: 'EntregaProyecto', schema: ProjectSchema }])],
  controllers: [ProjectsController],
  providers: [ProjectsService, { provide: ProjectCoursePort, useClass: UnintegratedProjectCourse }, { provide: ProjectFilePort, useClass: UnconfiguredProjectFiles },
    { provide: ProjectSubmissionPort, useExisting: ProjectsService }],
  exports: [ProjectSubmissionPort],
})
export class ProjectsModule {}
