import { Usuario } from '../infrastructure/schemas/identity.schemas';
import { validVerificationState } from '../infrastructure/legacy-security';

export function eligibleSessionAccount(user: Usuario | null): boolean {
  return Boolean(user && user.verificadoEn instanceof Date && Number.isFinite(user.verificadoEn.getTime()) && user.verificadoEn.getTime() <= Date.now() &&
    (user.seguridadVerificacion === undefined || validVerificationState(user.seguridadVerificacion)));
}
