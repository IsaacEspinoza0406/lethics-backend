import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AccessControlModule } from '../auth/access-control.module';
import { AssessmentContextPort, UnintegratedAssessmentContext } from './application/assessment-context';
import { AssessmentsService } from './application/assessments.service';
import { AttemptSchema, EvaluationSchema } from './infrastructure/assessment.schemas';
import { AssessmentHistoryController, AssessmentsController } from './presentation/assessments.controller';

@Module({
  imports: [AccessControlModule, MongooseModule.forFeature([{ name: 'Evaluacion', schema: EvaluationSchema }, { name: 'IntentoEvaluacion', schema: AttemptSchema }])],
  controllers: [AssessmentsController, AssessmentHistoryController],
  providers: [AssessmentsService, { provide: AssessmentContextPort, useClass: UnintegratedAssessmentContext }],
  exports: [AssessmentsService],
})
export class AssessmentsModule {}
