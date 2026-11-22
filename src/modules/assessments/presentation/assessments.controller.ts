import { Controller, Get, Header, Param, Post, Body, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser, CurrentUser, Roles } from '../../auth/access-control';
import { AssessmentsService } from '../application/assessments.service';
import { AttemptParams, EvaluationListDto, EvaluationParams, EvaluationScopeDto, HistoryDto, SubmitAttemptDto } from './assessment.dto';

@ApiTags('evaluaciones')
@ApiBearerAuth('access-token')
@ApiResponse({ status: 400, description: 'Entrada inválida o respuestas incompletas/duplicadas.' })
@ApiResponse({ status: 401, description: 'Autenticación no válida.' })
@ApiResponse({ status: 403, description: 'Rol no permitido, requisitos del examen pendientes o tres intentos agotados.' })
@ApiResponse({ status: 404, description: 'Cuestionario no publicado o no disponible.' })
@ApiResponse({ status: 503, description: 'MongoDB, índices o integración educativa no disponibles.' })
@Roles('estudiante')
@Controller('evaluaciones')
export class AssessmentsController {
  constructor(private readonly service: AssessmentsService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Evaluaciones publicadas disponibles; cuestionarios por módulo o examen_final por curso.' })
  @ApiOkResponse({ description: 'items, pagina y limite; preguntas sin opción correcta.' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: EvaluationListDto) { return this.service.list(user.id, query); }

  @Get(':evaluacionId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Consultar una versión publicada sin claves de corrección.' })
  @ApiOkResponse({ description: 'id, cursoId, moduloId, tipo, version, minimoAprobatorio y preguntas con opciones públicas.' })
  get(@CurrentUser() user: AuthenticatedUser, @Param() params: EvaluationParams, @Query() query: EvaluationScopeDto) { return this.service.get(user.id, params.evaluacionId, query.cursoId); }

  @Post(':evaluacionId/intentos')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Responder todas las preguntas y registrar un intento independiente.', description: 'El mismo solicitudId y envío devuelve el intento original. Un identificador nuevo inicia otro intento. Examen final: cursoId en query, cinco módulos completos, entrega válida y máximo tres intentos por estudiante/curso entre todas las versiones. No admite calificación ni usuarioId del cliente.' })
  @ApiCreatedResponse({ description: 'Intento calificado por el servidor; mismo documento/respuesta en reintentos idempotentes.' })
  @ApiResponse({ status: 409, description: 'Versión incompatible o solicitudId reutilizado con otro contenido.' })
  submit(@CurrentUser() user: AuthenticatedUser, @Param() params: EvaluationParams, @Body() body: SubmitAttemptDto, @Query() query: EvaluationScopeDto) { return this.service.submit(user.id, params.evaluacionId, body, query.cursoId); }
}

@ApiTags('intentos-evaluacion')
@ApiBearerAuth('access-token')
@ApiResponse({ status: 400, description: 'Identificadores o paginación inválidos.' })
@ApiResponse({ status: 401, description: 'Autenticación no válida.' })
@ApiResponse({ status: 403, description: 'Rol no permitido.' })
@ApiResponse({ status: 503, description: 'Almacenamiento no disponible.' })
@Roles('estudiante')
@Controller('intentos-evaluacion')
export class AssessmentHistoryController {
  constructor(private readonly service: AssessmentsService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Historial propio, paginado, con filtros por evaluación/módulo/curso y orden acotado.' })
  @ApiOkResponse({ description: 'items, pagina, limite y hayMas. No contiene intentos de otros estudiantes.' })
  history(@CurrentUser() user: AuthenticatedUser, @Query() query: HistoryDto) { return this.service.history(user.id, query); }
  @Get(':intentoId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Consultar un intento propio y su calificación.' })
  @ApiOkResponse({ description: 'Intento propio con respuestas enviadas y resultado, sin clave de respuestas correctas.' })
  @ApiResponse({ status: 404, description: 'Intento inexistente o perteneciente a otra cuenta.' })
  get(@CurrentUser() user: AuthenticatedUser, @Param() params: AttemptParams) { return this.service.getAttempt(user.id, params.intentoId); }
}
