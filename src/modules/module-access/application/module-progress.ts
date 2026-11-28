import { Injectable, ServiceUnavailableException } from '@nestjs/common';

/**
 * Read-only contract with the progress module (Backend B, increment 3). Modules and their activities are gated by it.
 * `completedModules` returns the ids of the course modules that satisfy the rule agreed for opening the next
 * module; the rule itself belongs to the progress module, never to the content modules.
 * A failure must throw: it must never be turned into "nothing completed" or "everything open".
 */
export abstract class ModuleProgressPort {
  abstract completedModules(usuarioId: string, cursoId: string): Promise<readonly string[]>;
}

/** Until the progress module exists, any request that needs unlock information is refused with 503. */
@Injectable()
export class UnintegratedModuleProgress extends ModuleProgressPort {
  async completedModules(usuarioId: string, cursoId: string): Promise<readonly string[]> {
    void usuarioId; void cursoId;
    throw new ServiceUnavailableException('Integración de progreso pendiente.');
  }
}
