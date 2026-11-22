import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { CourseProject, ProjectCoursePort, ProjectFilePort, ProjectSubmissionPort } from './project-ports';
import { canonicalEvidence, Evidence, EvidenceInput, evidenceInput, ProjectSubmission, submissionSlot, validFile, validPolicy, validSubmission, validText } from '../domain/project';

type Stored = ProjectSubmission & { _id: Types.ObjectId };
@Injectable()
export class ProjectsService implements ProjectSubmissionPort {
  constructor(@InjectConnection() private readonly connection: Connection,
    @InjectModel('EntregaProyecto') private readonly submissions: Model<ProjectSubmission>,
    private readonly courses: ProjectCoursePort, private readonly files: ProjectFilePort) {}

  private async controlled<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); }
    catch (error) { if (error instanceof HttpException) throw error; throw new ServiceUnavailableException('Proyectos no disponibles.'); }
  }
  private id(value: string): Types.ObjectId {
    if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) throw new BadRequestException('Identificador inválido.');
    return new Types.ObjectId(value);
  }
  private inputs(values: EvidenceInput[]): EvidenceInput[] {
    try { return canonicalEvidence(values); } catch { throw new BadRequestException('Evidencias inválidas.'); }
  }
  private async storage(write = false): Promise<void> {
    if (this.connection.readyState !== 1 || !this.connection.db || !(await this.connection.db.listCollections({ name: 'entregas_proyecto' }, { nameOnly: true }).toArray()).length) throw new Error('Almacenamiento sin preparar');
    if (write) {
      const indexes = await this.connection.db.collection('entregas_proyecto').listIndexes().toArray();
      if (!indexes.some((i) => i.name === 'usuarioId_1_solicitudId_1' && i.unique === true && !i.hidden && !i.sparse && !i.partialFilterExpression &&
        Object.keys(i.key).join(',') === 'usuarioId,solicitudId' && i.key.usuarioId === 1 && i.key.solicitudId === 1 && (!i.collation || i.collation.locale === 'simple'))) throw new Error('Índice no disponible');
    }
  }
  private async course(user: string, course: string): Promise<CourseProject> {
    const value = await this.courses.describe(Object.freeze({ usuarioId: user, cursoId: course }));
    if (!value) throw new NotFoundException('Proyecto no disponible.');
    if (value.cursoId !== course || !validText(value.instrucciones, 20000) || !validPolicy(value.politica)) throw new Error('Contrato de curso incompatible');
    const p = value.politica;
    return { cursoId: value.cursoId, instrucciones: value.instrucciones, politica: {
      maxEntregas: p.maxEntregas, maxEnlaces: p.maxEnlaces, hostsEnlace: [...p.hostsEnlace], maxArchivos: p.maxArchivos,
      formatosArchivo: [...p.formatosArchivo], maxArchivoBytes: p.maxArchivoBytes,
    } };
  }
  private view(value: Stored) {
    if (!validSubmission(value)) throw new Error('Entrega incompatible');
    return { id: value._id.toHexString(), cursoId: value.cursoId.toHexString(), solicitudId: value.solicitudId, estado: value.estado, fechaEntrega: value.fechaEntrega.toISOString(),
      evidencias: value.evidencias.map((e) => e.tipo === 'enlace' ? { tipo: e.tipo, url: e.url } : { tipo: e.tipo, nombre: e.nombre, mime: e.mime, bytes: e.bytes }) };
  }
  private replay(value: Stored, cursoId: Types.ObjectId, inputs: EvidenceInput[]) {
    if (!value.cursoId.equals(cursoId) || JSON.stringify(evidenceInput(value.evidencias)) !== JSON.stringify(inputs)) throw new ConflictException('solicitudId ya utilizado para otra entrega.');
    return this.view(value);
  }
  async instructions(user: string, course: string) {
    return this.controlled(async () => { const usuarioId = this.id(user), cursoId = this.id(course); return this.course(usuarioId.toHexString(), cursoId.toHexString()); });
  }
  async submit(user: string, course: string, input: { solicitudId: string; evidencias: EvidenceInput[] }) {
    return this.controlled(async () => {
      const usuarioId = this.id(user), cursoId = this.id(course), inputs = this.inputs(input.evidencias);
      if (!validText(input.solicitudId, 128)) throw new BadRequestException('solicitudId inválido.');
      await this.storage(true);
      const filter = { usuarioId, solicitudId: input.solicitudId }, previous = await this.submissions.findOne(filter).lean();
      if (previous) return this.replay(previous, cursoId, inputs);
      const definition = await this.course(usuarioId.toHexString(), cursoId.toHexString()), policy = definition.politica;
      if (inputs.filter((e) => e.tipo === 'enlace').length > policy.maxEnlaces || inputs.filter((e) => e.tipo === 'archivo').length > policy.maxArchivos) throw new BadRequestException('Cantidad de evidencias no permitida.');
      const evidencias: Evidence[] = [];
      for (const evidence of inputs) {
        if (evidence.tipo === 'enlace') {
          if (!policy.hostsEnlace.includes(new URL(evidence.url).hostname)) throw new BadRequestException('Enlace no permitido por el curso.');
          evidencias.push(evidence);
        } else {
          const file = await this.files.verify(Object.freeze({ usuarioId: usuarioId.toHexString(), cursoId: cursoId.toHexString() }), evidence.referencia);
          if (!file || file.usuarioId !== usuarioId.toHexString() || file.cursoId !== cursoId.toHexString() || file.referencia !== evidence.referencia) throw new BadRequestException('Archivo no disponible para esta entrega.');
          if (!validFile(file)) throw new Error('Prueba de archivo incompatible');
          if (!policy.formatosArchivo.includes(file.mime) || file.bytes > policy.maxArchivoBytes) throw new BadRequestException('Formato o tamaño del archivo no permitido.');
          evidencias.push({ tipo: 'archivo', referencia: file.referencia, nombre: file.nombre, mime: file.mime, bytes: file.bytes, sha256: file.sha256 });
        }
      }
      const session = await this.connection.startSession();
      try {
        // Bounded retries: remaining transient contention may return 503; never exceed policy.
        for (let retry = 0; retry < 4; retry++) {
          try {
            return await session.withTransaction(async () => {
              const previous = await this.submissions.findOne(filter).session(session).lean();
              if (previous) return this.replay(previous, cursoId, inputs);
              const count = await this.submissions.countDocuments({ usuarioId, cursoId }).session(session);
              if (count >= policy.maxEntregas) throw new ForbiddenException('Límite de entregas del proyecto agotado.');
              const [record] = await this.submissions.create([{ _id: submissionSlot(usuarioId, cursoId, count + 1), usuarioId, cursoId,
                solicitudId: input.solicitudId, fechaEntrega: new Date(), estado: 'registrada', evidencias }], { session });
              return this.view(record.toObject() as Stored);
            }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
          } catch (error) {
            if ((error as { code?: number }).code !== 11000) throw error;
            const winner = await this.submissions.findOne(filter).lean();
            if (winner) return this.replay(winner, cursoId, inputs);
            if (retry === 3) throw error;
          }
        }
        throw new Error('Contención no resuelta');
      } finally { await session.endSession(); }
    });
  }
  async history(user: string, course: string, page: { pagina: number; limite: number }) {
    return this.controlled(async () => {
      await this.storage();
      const records = await this.submissions.find({ usuarioId: this.id(user), cursoId: this.id(course) }).sort({ fechaEntrega: -1, _id: -1 }).skip((page.pagina - 1) * page.limite).limit(page.limite + 1).lean();
      return { items: records.slice(0, page.limite).map((r) => this.view(r)), ...page, hayMas: records.length > page.limite };
    });
  }
  async get(user: string, submission: string) {
    return this.controlled(async () => {
      await this.storage();
      const record = await this.submissions.findOne({ _id: this.id(submission), usuarioId: this.id(user) }).lean();
      if (!record) throw new NotFoundException('Entrega no disponible.');
      return this.view(record);
    });
  }
  async hasValidSubmission(user: string, course: string): Promise<boolean> {
    return this.controlled(async () => {
      await this.storage();
      const record = await this.submissions.findOne({ usuarioId: this.id(user), cursoId: this.id(course), estado: 'registrada' }).sort({ fechaEntrega: -1, _id: -1 }).lean();
      if (!record) return false;
      if (!validSubmission(record)) throw new Error('Entrega incompatible');
      return true;
    });
  }
}
