import { Types } from 'mongoose';
import { Stored } from '../src/modules/learning/domain/learning';
import { Simulator } from '../src/modules/simulators/domain/simulator';

/** Synthetic case only: it is not (and must not contain) the private academic material. */
export const simulatorFixture = (moduloId: Types.ObjectId, overrides: Partial<Simulator> = {}): Stored<Simulator> => ({
  _id: new Types.ObjectId(), moduloId, titulo: 'Caso sintético', version: 1, contexto: 'Contexto sintético.', consigna: 'Consigna sintética.',
  modo: 'ia_asistida', activo: true, ...overrides,
});
