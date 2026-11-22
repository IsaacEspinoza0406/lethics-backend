import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser, CurrentUser, Roles } from '../../auth/access-control';
import { LearningService } from '../application/learning.service';
import { CourseListDto, CourseParams, LessonParams, ModuleParams } from './learning.dto';

@ApiTags('contenido-educativo')
@ApiBearerAuth('access-token')
@ApiResponse({ status: 400, description: 'Identificador o paginación inválidos.' })
@ApiResponse({ status: 401, description: 'Autenticación no válida.' })
@ApiResponse({ status: 403, description: 'Rol no permitido o módulo aún no disponible para el estudiante.' })
@ApiResponse({ status: 404, description: 'Recurso inexistente, inactivo, en borrador o no publicado.' })
@ApiResponse({ status: 503, description: 'MongoDB, contenido incompatible o integración de progreso no disponible.' })
@Roles('estudiante')
@Controller()
export class LearningController {
  constructor(private readonly service: LearningService) {}

  @Get('cursos') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Cursos publicados.' })
  @ApiOkResponse({ description: 'items (id, titulo), pagina, limite y hayMas. Los cursos en borrador no aparecen.' })
  courses(@Query() page: CourseListDto) { return this.service.courses(page); }

  @Get('cursos/:cursoId') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Detalle de un curso publicado, con las instrucciones del proyecto final.' })
  @ApiOkResponse({ description: 'id, titulo y proyectoFinal (instrucciones, requisitos y formatosPermitidos). La política de entregas se consulta en GET /cursos/:cursoId/proyecto.' })
  course(@Param() params: CourseParams) { return this.service.course(params.cursoId); }

  @Get('cursos/:cursoId/modulos') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Módulos activos del curso en orden, con su disponibilidad para el estudiante.', description: 'Todos los módulos activos son visibles. El primero siempre está disponible; cada siguiente solo cuando el módulo anterior está completado según el módulo de progreso.' })
  @ApiOkResponse({ description: 'cursoId e items (id, orden, titulo, disponible).' })
  modules(@CurrentUser() user: AuthenticatedUser, @Param() params: CourseParams) { return this.service.modules(user.id, params.cursoId); }

  @Get('modulos/:moduloId/lecciones') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Lecciones activas de un módulo disponible, en orden.' })
  @ApiOkResponse({ description: 'moduloId, cursoId e items (id, orden, titulo, version). 403 si el módulo todavía no está disponible.' })
  lessons(@CurrentUser() user: AuthenticatedUser, @Param() params: ModuleParams) { return this.service.lessons(user.id, params.moduloId); }

  @Get('lecciones/:leccionId') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Contenido de una lección activa de un módulo disponible.', description: 'secciones usa los bloques titulo, parrafo, lista, tabla, destacado y recurso. Un recurso indica operativo=false mientras su servicio no esté disponible.' })
  @ApiOkResponse({ description: 'id, moduloId, cursoId, orden, titulo, version y secciones.' })
  lesson(@CurrentUser() user: AuthenticatedUser, @Param() params: LessonParams) { return this.service.lesson(user.id, params.leccionId); }
}
