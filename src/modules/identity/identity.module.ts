import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SesionSchema, TokenCuentaSchema, UsuarioSchema } from './infrastructure/schemas/identity.schemas';

@Module({
  imports: [MongooseModule.forFeature([
    { name: 'Usuario', schema: UsuarioSchema },
    { name: 'TokenCuenta', schema: TokenCuentaSchema },
    { name: 'Sesion', schema: SesionSchema },
  ])],
  exports: [MongooseModule],
})
export class IdentityModule {}
