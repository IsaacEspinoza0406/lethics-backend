import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Usuario } from '../infrastructure/schemas/identity.schemas';
import { eligibleSessionAccount } from './session-account-policy';

export interface PublicUserProfile { id: string; nombre: string; correo: string; rol: string }

@Injectable()
export class AuthenticatedIdentityService {
  constructor(@InjectModel('Usuario') private readonly users: Model<Usuario>) {}

  async findEligibleProfile(id: string): Promise<PublicUserProfile | null> {
    if (!/^[a-f\d]{24}$/i.test(id)) return null;
    let user: Usuario | null;
    try {
      user = await this.users.findById(id).select({ _id: 1, nombre: 1, correo: 1, rol: 1, verificadoEn: 1, seguridadVerificacion: 1 }).lean<Usuario>().exec();
    } catch { throw new ServiceUnavailableException('Autenticación no disponible.'); }
    if (!eligibleSessionAccount(user) || !user || typeof user.rol !== 'string' || !user.rol.trim() || typeof user.nombre !== 'string' || typeof user.correo !== 'string') return null;
    return { id: id.toLowerCase(), nombre: user.nombre, correo: user.correo, rol: user.rol };
  }
}
