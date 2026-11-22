import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AccessControlModule } from '../auth/access-control.module';
import { AssessmentContextPort, AssessmentResultsPort } from './application/assessment-context';
import { AssessmentProgressPort, ProjectAssessmentContext, UnintegratedAssessmentProgress } from './application/project-assessment-context';
import { ProjectsModule } from '../projects/projects.module';
import { AssessmentsService } from './application/assessments.service';
import { AttemptSchema, EvaluationSchema } from './infrastructure/assessment.schemas';
import { AssessmentHistoryController, AssessmentsController } from './presentation/assessments.controller';

@Module({
  imports: [AccessControlModule, ProjectsModule, MongooseModule.forFeature([{ name: 'Evaluacion', schema: EvaluationSchema }, { name: 'IntentoEvaluacion', schema: AttemptSchema }])],
  controllers: [AssessmentsController, AssessmentHistoryController],
  providers: [AssessmentsService, { provide: AssessmentContextPort, useClass: ProjectAssessmentContext }, { provide: AssessmentProgressPort, useClass: UnintegratedAssessmentProgress }, { provide: AssessmentResultsPort, useExisting: AssessmentsService }],
  exports: [AssessmentsService, AssessmentResultsPort],
})
export class AssessmentsModule {}
