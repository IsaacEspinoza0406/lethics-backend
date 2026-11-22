import { Controller, Get, Header, Module, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AccessControlModule } from '../auth/access-control.module';
import { AuthenticatedUser, CurrentUser, Roles } from '../auth/access-control';
import { IdentityModule } from '../identity/identity.module';
import { AuthenticatedIdentityService, PublicUserProfile } from '../identity/application/authenticated-identity.service';

@ApiTags('users')
@ApiBearerAuth('access-token')
@ApiResponse({ status: 401, description: 'Autenticación no válida.' })
@ApiResponse({ status: 403, description: 'Acceso no permitido.' })
@ApiResponse({ status: 503, description: 'Dependencia de autenticación no disponible.' })
@Controller('users')
@Roles('estudiante')
export class UsersController {
  constructor(private readonly identities: AuthenticatedIdentityService) {}
  @Get('me')
  @Header('Cache-Control', 'no-store')
  @ApiOkResponse({ description: 'Perfil propio, exclusivamente id, nombre, correo y rol.', schema: { example: { id: '000000000000000000000001', nombre: 'Estudiante', correo: 'student@example.test', rol: 'estudiante' } } })
  async me(@CurrentUser() user: AuthenticatedUser): Promise<PublicUserProfile> {
    const profile = await this.identities.findEligibleProfile(user.id);
    if (!profile) throw new UnauthorizedException('Autenticación no válida.');
    if (profile.rol !== 'estudiante') throw new ForbiddenException('Acceso no permitido.');
    return profile;
  }
}

@Module({ imports: [AccessControlModule, IdentityModule], controllers: [UsersController] })
export class UsersModule {}
