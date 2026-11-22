import { Body, Controller, Get, Header, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser, CurrentUser, Roles } from '../../auth/access-control';
import { ProjectsService } from '../application/projects.service';
import { EvidenceInput } from '../domain/project';
import { ProjectCourseParams, ProjectHistoryDto, ProjectSubmissionParams, SubmitProjectDto } from './project.dto';

@ApiTags('proyectos')
@ApiBearerAuth('access-token')
@ApiResponse({ status: 400, description: 'Entrada, evidencia, formato o tamaño inválidos.' })
@ApiResponse({ status: 401, description: 'Autenticación inválida.' })
@ApiResponse({ status: 403, description: 'Rol no permitido o límite de entregas agotado.' })
@ApiResponse({ status: 404, description: 'Proyecto o entrega no disponible para el estudiante.' })
@ApiResponse({ status: 503, description: 'Dependencias, política o almacenamiento no disponibles.' })
@Roles('estudiante')
@Controller()
export class ProjectsController {
  constructor(private readonly service: ProjectsService) {}
  @Get('cursos/:cursoId/proyecto') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Instrucciones y política autorizadas del proyecto del curso.' })
  @ApiOkResponse({ description: 'cursoId, instrucciones y politica. Sin valores académicos predeterminados.' })
  instructions(@CurrentUser() user: AuthenticatedUser, @Param() params: ProjectCourseParams) { return this.service.instructions(user.id, params.cursoId); }

  @Post('cursos/:cursoId/entregas-proyecto') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Registrar evidencias del estudiante según la política del curso.', description: 'No sube archivos. Archivo exige referencia verificada por un almacenamiento confiable. Mismo solicitudId/contenido recupera la entrega original; otro contenido produce 409.' })
  @ApiCreatedResponse({ description: 'Entrega registrada con fecha del servidor y evidencias públicas; no revela claves privadas de archivos ni hashes.' })
  @ApiResponse({ status: 409, description: 'solicitudId ya usado para otra entrega.' })
  submit(@CurrentUser() user: AuthenticatedUser, @Param() params: ProjectCourseParams, @Body() body: SubmitProjectDto) {
    // The application validates the discriminated shape, including forbidden mixed fields.
    return this.service.submit(user.id, params.cursoId, { solicitudId: body.solicitudId, evidencias: body.evidencias as EvidenceInput[] });
  }
  @Get('cursos/:cursoId/entregas-proyecto') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Historial propio por curso, fecha descendente y paginación.' })
  @ApiOkResponse({ description: 'items, pagina, limite y hayMas; solo entregas del usuario autenticado.' })
  history(@CurrentUser() user: AuthenticatedUser, @Param() params: ProjectCourseParams, @Query() page: ProjectHistoryDto) { return this.service.history(user.id, params.cursoId, page); }

  @Get('entregas-proyecto/:entregaId') @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Detalle público de una entrega propia.' })
  @ApiOkResponse({ description: 'id, cursoId, solicitudId, estado, fechaEntrega y evidencias; sin usuarioId ni referencias de almacenamiento.' })
  get(@CurrentUser() user: AuthenticatedUser, @Param() params: ProjectSubmissionParams) { return this.service.get(user.id, params.entregaId); }
}
