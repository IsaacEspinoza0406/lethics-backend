import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Logger, Post, Req, UseGuards } from '@nestjs/common';
import { ApiAcceptedResponse, ApiBadRequestResponse, ApiOkResponse, ApiOperation, ApiProperty, ApiResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { IdentityOperationsService } from '../identity/application/identity-operations.service';
import { VerificationDeliveryError, VerificationStateUnavailableError } from '../identity/application/verification-mailer';
import { RegisterDto } from '../identity/presentation/dto/register.dto';
import { VerifyEmailDto } from '../identity/presentation/dto/verify-email.dto';
import { ResendVerificationDto } from '../identity/presentation/dto/resend-verification.dto';
import { AuthHttpGuard, AuthOperation, AuthRequest, AUTH_ORIGIN_PERMIT } from './auth-http.guard';
import { authHttpFailure } from './auth-http.errors';

export class AuthMessageDto {
  @ApiProperty({ example: 'Solicitud recibida.' })
  message!: string;
}

@ApiTags('auth')
@ApiBadRequestResponse({ description: 'Entrada inválida; verify también usa 400 para código inválido, expirado, usado o restringido.' })
@ApiResponse({ status: 429, description: 'Cuota por origen excedida.' })
@ApiServiceUnavailableResponse({ description: 'Operación deshabilitada o una protección/dependencia obligatoria no está disponible.' })
@Controller('auth')
@UseGuards(AuthHttpGuard)
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  constructor(private readonly operations: IdentityOperationsService) {}

  private async command(operation: 'register' | 'resend', run: () => Promise<void>): Promise<AuthMessageDto> {
    try { await run(); }
    catch (error) {
      if (error instanceof VerificationDeliveryError) this.logger.error('Entrega de verificación no confirmada');
      else if (!(operation === 'resend' && error instanceof VerificationStateUnavailableError)) throw authHttpFailure(error);
    }
    // Identical for duplicate/missing/verified/restricted accounts; never claim delivery.
    return { message: 'Solicitud recibida.' };
  }

  @Post('register')
  @AuthOperation('register')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Solicitar registro de estudiante' })
  @ApiAcceptedResponse({ type: AuthMessageDto, description: 'Respuesta genérica; no confirma existencia de cuenta ni entrega de correo.' })
  register(@Body() input: RegisterDto, @Req() request: AuthRequest): Promise<AuthMessageDto> {
    return this.command('register', () => this.operations.register(request.socket.remoteAddress, false, input, request[AUTH_ORIGIN_PERMIT]));
  }

  @Post('verify')
  @AuthOperation('verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verificar correo con código de un solo uso' })
  @ApiOkResponse({ description: 'Correo verificado. No emite credenciales de acceso.', schema: { type: 'object', required: ['message'], properties: { message: { type: 'string', example: 'Correo verificado.' } } } })
  async verify(@Body() input: VerifyEmailDto, @Req() request: AuthRequest): Promise<AuthMessageDto> {
    let verified: boolean;
    try { verified = await this.operations.verify(request.socket.remoteAddress, false, input.correo, input.codigo, request[AUTH_ORIGIN_PERMIT]); }
    catch (error) { throw authHttpFailure(error); }
    if (!verified) throw new BadRequestException('No se pudo verificar el código');
    return { message: 'Correo verificado.' };
  }

  @Post('resend')
  @AuthOperation('resend')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Solicitar un nuevo código de verificación' })
  @ApiAcceptedResponse({ type: AuthMessageDto, description: 'Respuesta genérica, también para correo inexistente, verificado o con límites de cuenta activos.' })
  resend(@Body() input: ResendVerificationDto, @Req() request: AuthRequest): Promise<AuthMessageDto> {
    return this.command('resend', () => this.operations.resend(request.socket.remoteAddress, false, input.correo, request[AUTH_ORIGIN_PERMIT]));
  }
}
