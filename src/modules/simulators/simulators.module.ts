import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AccessControlModule } from '../auth/access-control.module';
import { LearningContentModule } from '../learning/learning-content.module';
import { ModuleAccessModule } from '../module-access/module-access.module';
import { ProgressDataModule } from '../progress/progress-data.module';
import { SimulatorsService } from './application/simulators.service';
import { SimulatorResponseSchema, SimulatorSchema } from './infrastructure/simulator.schemas';
import { SimulatorsController } from './presentation/simulators.controller';

/** Ethics simulators and the students' answers. */
@Module({
  imports: [AccessControlModule, LearningContentModule, ModuleAccessModule, ProgressDataModule,
    MongooseModule.forFeature([{ name: 'Simulador', schema: SimulatorSchema }, { name: 'RespuestaSimulador', schema: SimulatorResponseSchema }])],
  controllers: [SimulatorsController],
  providers: [SimulatorsService],
})
export class SimulatorsModule {}
