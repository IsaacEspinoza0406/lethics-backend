import { Body, Controller, Get, Header, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser, CurrentUser, Roles } from '../../auth/access-control';
import { CourseListDto, ModuleParams } from '../../learning/presentation/learning.dto';
import { SimulatorsService } from '../application/simulators.service';
import { SimulatorAnswerDto, SimulatorParams } from './simulators.dto';

const answer = 'id, simuladorId, version, decision, fecha y estadoIA';

@ApiTags('simuladores')
@ApiBearerAuth('access-token')
@ApiResponse({ status: 400, description: 'Identificador, paginación o respuesta inválidos.' })
@ApiResponse({ status: 401, description: 'Autenticación no válida.' })
@ApiResponse({ status: 403, description: 'Rol no permitido o módulo aún no disponible para el estudiante.' })
@ApiResponse({ status: 404, description: 'Simulador o módulo inexistente, inactivo o de un curso no publicado.' })
@ApiResponse({ status: 503, description: 'MongoDB, almacenamiento sin preparar o datos incompatibles.' })
@Roles('estudiante')
@Controller()
export class SimulatorsController {
  constructor(private readonly service: SimulatorsService) {}

  @Get('modulos/:moduloId/simuladores') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Casos activos de un módulo disponible.' })
  @ApiOkResponse({ description: 'moduloId, cursoId e items (id, titulo, version, contexto, consigna, modo).' })
  list(@CurrentUser() user: AuthenticatedUser, @Param() params: ModuleParams) { return this.service.list(user.id, params.moduloId); }

  @Post('simuladores/:simuladorId/respuestas') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Envía una respuesta al caso.', description: 'Se conservan todas las respuestas. Queda como pendiente_ia, sin retroalimentación, y completa la lección del simulador. Cada envío crea una respuesta nueva.' })
  @ApiCreatedResponse({ description: `${answer}.` })
  @ApiResponse({ status: 409, description: 'La versión enviada ya no es la del caso.' })
  respond(@CurrentUser() user: AuthenticatedUser, @Param() params: SimulatorParams, @Body() body: SimulatorAnswerDto) { return this.service.respond(user.id, params.simuladorId, body); }

  @Get('simuladores/:simuladorId/respuestas') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Respuestas propias a un caso, de la más reciente a la más antigua.' })
  @ApiOkResponse({ description: `items (${answer}), pagina, limite y hayMas.` })
  history(@CurrentUser() user: AuthenticatedUser, @Param() params: SimulatorParams, @Query() page: CourseListDto) { return this.service.history(user.id, params.simuladorId, page); }
}
