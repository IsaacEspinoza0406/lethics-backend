import { Body, Controller, Get, Header, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser, CurrentUser, Roles } from '../../auth/access-control';
import { LessonParams, ModuleParams } from '../../learning/presentation/learning.dto';
import { LessonProgressService } from '../application/lesson-progress.service';
import { ReadingPositionDto } from './progress.dto';

const state = 'leccionId, estado (no_iniciada, en_progreso o completada), puntoActual, actualizadoEn y completadaEn.';

@ApiTags('progreso')
@ApiBearerAuth('access-token')
@ApiResponse({ status: 400, description: 'Identificador o posición inválidos.' })
@ApiResponse({ status: 401, description: 'Autenticación no válida.' })
@ApiResponse({ status: 403, description: 'Rol no permitido o módulo aún no disponible para el estudiante.' })
@ApiResponse({ status: 404, description: 'Lección o módulo inexistente, inactivo o de un curso no publicado.' })
@ApiResponse({ status: 503, description: 'MongoDB, almacenamiento sin preparar o datos incompatibles.' })
@Roles('estudiante')
@Controller()
export class ProgressController {
  constructor(private readonly service: LessonProgressService) {}

  @Get('modulos/:moduloId/progreso') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Avance del estudiante en las lecciones activas de un módulo disponible.' })
  @ApiOkResponse({ description: `moduloId, cursoId e items en orden, cada uno con orden, ${state}` })
  module(@CurrentUser() user: AuthenticatedUser, @Param() params: ModuleParams) { return this.service.moduleProgress(user.id, params.moduloId); }

  @Put('lecciones/:leccionId/progreso') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Guarda la posición de lectura.', description: 'Sirve para continuar desde otro dispositivo. Nunca devuelve una lección completada a en_progreso.' })
  @ApiOkResponse({ description: state })
  save(@CurrentUser() user: AuthenticatedUser, @Param() params: LessonParams, @Body() body: ReadingPositionDto) { return this.service.save(user.id, params.leccionId, body.puntoActual); }

  @Post('lecciones/:leccionId/completar') @HttpCode(200) @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Marca como completada una lección de lectura.', description: 'Se llama cuando el estudiante llega al final. Es idempotente y conserva la primera fecha.' })
  @ApiOkResponse({ description: state })
  @ApiResponse({ status: 409, description: 'La lección se completa al enviar su simulador o cuestionario.' })
  complete(@CurrentUser() user: AuthenticatedUser, @Param() params: LessonParams) { return this.service.complete(user.id, params.leccionId); }
}
