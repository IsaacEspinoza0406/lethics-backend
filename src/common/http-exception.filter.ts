import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    if (status >= 500) this.logger.error(`HTTP ${status} ${request.method} ${request.path}`);
    const body = exception instanceof HttpException ? exception.getResponse() : null;
    const message = status >= 500 ? 'Error interno del servidor' :
      typeof body === 'string' ? body : (body as { message?: string | string[] } | null)?.message ?? 'Error de solicitud';
    const health = status === 503 && request.path === '/api/v1/health' ? { api: 'up', mongodb: 'down' } : {};
    response.status(status).json({ statusCode: status, message, ...health, path: request.path, timestamp: new Date().toISOString() });
  }
}
