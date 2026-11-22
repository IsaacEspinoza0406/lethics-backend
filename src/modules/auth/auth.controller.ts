import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Logger, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { ApiAcceptedResponse, ApiBadRequestResponse, ApiOkResponse, ApiOperation, ApiProperty, ApiResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { IdentityOperationsService } from '../identity/application/identity-operations.service';
import { VerificationDeliveryError, VerificationStateUnavailableError } from '../identity/application/verification-mailer';
import { RegisterDto } from '../identity/presentation/dto/register.dto';
import { VerifyEmailDto } from '../identity/presentation/dto/verify-email.dto';
import { ResendVerificationDto } from '../identity/presentation/dto/resend-verification.dto';
import { AuthHttpGuard, AuthOperation, AuthRequest, AUTH_ORIGIN_PERMIT } from './auth-http.guard';
import { authHttpFailure } from './auth-http.errors';
import { LoginDto } from '../identity/presentation/dto/login.dto';
import { readRefreshCookie, refreshCookieOptions } from './login-http.policy';
import { LoginResult } from '../identity/application/login.service';
import { SessionDeniedError } from '../identity/application/session.service';
import { Public } from './access-control';

export class AuthMessageDto {
  @ApiProperty({ example: 'Solicitud recibida.' })
  message!: string;
}

export class LoginResponseDto {
  @ApiProperty({ description: 'JWT de acceso; mantener en memoria del cliente.' }) accessToken!: string;
  @ApiProperty({ example: 'Bearer' }) tokenType!: string;
  @ApiProperty({ example: 900 }) expiresIn!: number;
}

@ApiTags('auth')
@ApiBadRequestResponse({ description: 'Entrada inválida; verify también usa 400 para código inválido, expirado, usado o restringido.' })
@ApiResponse({ status: 429, description: 'Cuota por origen excedida.' })
@ApiServiceUnavailableResponse({ description: 'Operación deshabilitada o una protección/dependencia obligatoria no está disponible.' })
@Controller('auth')
@Public()
@UseGuards(AuthHttpGuard)
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  constructor(private readonly operations: IdentityOperationsService, private readonly config: ConfigService) {}

  private sessionResponse(result: LoginResult, response: Response): LoginResponseDto {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Pragma', 'no-cache');
    response.cookie('lethics_refresh', result.refreshToken, { ...refreshCookieOptions(this.config), expires: result.refreshExpiresAt, maxAge: Math.max(0, result.refreshExpiresAt.getTime() - Date.now()) });
    return { accessToken: result.accessToken, tokenType: 'Bearer', expiresIn: result.expiresIn };
  }

  @Post('refresh')
  @AuthOperation('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotar refresh de un solo uso y renovar acceso', description: 'Exige cookie y Origin autorizado; body JSON vacío. Reutilización de un token revocado invalida su familia.' })
  @ApiOkResponse({ type: LoginResponseDto, description: 'Nueva cookie HttpOnly y access token; no extiende la expiración absoluta de la familia.' })
  @ApiResponse({ status: 401, description: 'Sesión no válida; se elimina cookie.' })
  @ApiResponse({ status: 403, description: 'Origin obligatorio, exacto y sin cross-site.' })
  async refresh(@Req() request: AuthRequest, @Res({ passthrough: true }) response: Response): Promise<LoginResponseDto> {
    try {
      const result = await this.operations.refresh(request.socket.remoteAddress, false, readRefreshCookie(request), request[AUTH_ORIGIN_PERMIT]);
      return this.sessionResponse(result, response);
    } catch (error) {
      if (error instanceof SessionDeniedError) response.clearCookie('lethics_refresh', refreshCookieOptions(this.config));
      throw authHttpFailure(error);
    }
  }

  @Post('logout')
  @AuthOperation('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revocar sesión lógica y eliminar cookie', description: 'Idempotente para cookie ausente, desconocida, expirada o ya revocada. No revoca familias independientes.' })
  @ApiResponse({ status: 204, description: 'Revocación confirmada de la sesión identificada, si existe; cookie eliminada.' })
  @ApiResponse({ status: 403, description: 'Origin obligatorio, exacto y sin cross-site.' })
  async logout(@Req() request: AuthRequest, @Res({ passthrough: true }) response: Response): Promise<void> {
    try {
      await this.operations.logout(request.socket.remoteAddress, false, readRefreshCookie(request), request[AUTH_ORIGIN_PERMIT]);
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('Pragma', 'no-cache');
      response.clearCookie('lethics_refresh', refreshCookieOptions(this.config));
    } catch (error) { throw authHttpFailure(error); }
  }

  @Post('login')
  @AuthOperation('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Iniciar sesión con una cuenta verificada' })
  @ApiOkResponse({ type: LoginResponseDto, description: 'JWT de acceso y cookie lethics_refresh HttpOnly, SameSite=Strict, Secure en producción. No devuelve refresh en JSON.' })
  @ApiResponse({ status: 401, description: 'Credenciales no válidas.' })
  @ApiResponse({ status: 403, description: 'Origen de navegador no autorizado.' })
  @ApiResponse({ status: 415, description: 'Login exige application/json.' })
  async login(@Body() input: LoginDto, @Req() request: AuthRequest, @Res({ passthrough: true }) response: Response): Promise<LoginResponseDto> {
    try {
      refreshCookieOptions(this.config);
      const result = await this.operations.login(request.socket.remoteAddress, false, input, request[AUTH_ORIGIN_PERMIT]);
      return this.sessionResponse(result, response);
    } catch (error) { throw authHttpFailure(error); }
  }

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
