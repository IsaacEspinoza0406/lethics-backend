import { Controller, Get, Header, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser, CurrentUser, Roles } from '../../auth/access-control';
import { FlashcardsService } from '../application/flashcards.service';
import { DeckParams } from './flashcards.dto';

@ApiTags('flashcards')
@ApiBearerAuth('access-token')
@ApiResponse({ status: 400, description: 'Identificador inválido.' })
@ApiResponse({ status: 401, description: 'Autenticación no válida.' })
@ApiResponse({ status: 403, description: 'Rol no permitido o módulo aún no disponible para el estudiante.' })
@ApiResponse({ status: 404, description: 'Módulo inexistente, inactivo o de un curso no publicado.' })
@ApiResponse({ status: 503, description: 'MongoDB, contenido incompatible o integración de progreso no disponible.' })
@Roles('estudiante')
@Controller()
export class FlashcardsController {
  constructor(private readonly service: FlashcardsService) {}

  @Get('modulos/:moduloId/flashcards') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Mazo de flashcards de un módulo disponible, en el orden de presentación.', description: 'Incluye concepto y definición de cada tarjeta para girarla sin otra consulta.' })
  @ApiOkResponse({ description: 'moduloId, cursoId e items (id, orden, concepto, definicion). Un módulo sin tarjetas devuelve items vacío.' })
  deck(@CurrentUser() user: AuthenticatedUser, @Param() params: DeckParams) { return this.service.deck(user.id, params.moduloId); }
}
