import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { Types } from 'mongoose';

export interface ProjectPolicy {
  maxEntregas: number; maxEnlaces: number; hostsEnlace: readonly string[];
  maxArchivos: number; formatosArchivo: readonly string[]; maxArchivoBytes: number;
}
export interface FileMetadata { nombre: string; mime: string; bytes: number; sha256: string }

export type EvidenceInput = { tipo: 'enlace'; url: string } | { tipo: 'archivo'; referencia: string };
export type Evidence = { tipo: 'enlace'; url: string } | { tipo: 'archivo'; referencia: string; nombre: string; mime: string; bytes: number; sha256: string };
export interface ProjectSubmission {
  usuarioId: Types.ObjectId;
  cursoId: Types.ObjectId;
  solicitudId: string;
  fechaEntrega: Date;
  estado: 'registrada';
  evidencias: Evidence[];
}
export const EVIDENCE_BOUND = 20; // Technical document/request bound, not an academic link allowance.
export const validText = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const hasControl = (value: string) => [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
export function canonicalLink(value: string): string {
  if (!validText(value, 2048) || /[\s\\]/.test(value) || hasControl(value)) throw new TypeError('Enlace inválido');
  const url = new URL(value);
  if (url.href.length > 2048 || /%(?![a-f\d]{2})/i.test(value) || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
    !/^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,}$/i.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)) throw new TypeError('Enlace inválido');
  // No network request, DNS lookup, redirect following or URL dereferencing is performed.
  return url.href;
}
export function validPolicy(policy: ProjectPolicy): boolean {
  return Boolean(policy && Number.isSafeInteger(policy.maxEntregas) && policy.maxEntregas >= 1 && policy.maxEntregas <= 2147483647 &&
    [policy.maxEnlaces, policy.maxArchivos].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= EVIDENCE_BOUND) &&
    policy.maxEnlaces + policy.maxArchivos <= EVIDENCE_BOUND && policy.maxEnlaces + policy.maxArchivos > 0 &&
    Array.isArray(policy.hostsEnlace) && policy.hostsEnlace.length <= EVIDENCE_BOUND && (policy.maxEnlaces === 0 || policy.hostsEnlace.length > 0) &&
    policy.hostsEnlace.every((host) => typeof host === 'string' && canonicalLink(`https://${host}/`) === `https://${host}/`) &&
    Array.isArray(policy.formatosArchivo) && policy.formatosArchivo.length <= EVIDENCE_BOUND && (policy.maxArchivos === 0 || policy.formatosArchivo.length > 0) &&
    policy.formatosArchivo.every((mime) => validText(mime, 128) && /^[a-z\d.+-]+\/[a-z\d.+-]+$/.test(mime)) &&
    Number.isSafeInteger(policy.maxArchivoBytes) && policy.maxArchivoBytes >= (policy.maxArchivos > 0 ? 1 : 0) && policy.maxArchivoBytes <= 2147483647);
}
export function canonicalEvidence(values: EvidenceInput[]): EvidenceInput[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > EVIDENCE_BOUND) throw new TypeError('Evidencias inválidas');
  const result = values.map((value): EvidenceInput => {
    // class-transformer materializes optional DTO fields as undefined under ES2022.
    const keys = Object.entries(value ?? {}).filter(([, v]) => v !== undefined).map(([key]) => key).sort().join(',');
    if (value?.tipo === 'enlace' && keys === 'tipo,url') return { tipo: 'enlace', url: canonicalLink(value.url) };
    if (value?.tipo === 'archivo' && keys === 'referencia,tipo' && typeof value.referencia === 'string' && /^[a-zA-Z\d_-]{1,128}$/.test(value.referencia)) return { tipo: 'archivo', referencia: value.referencia };
    throw new TypeError('Evidencia inválida');
  }).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  if (new Set(result.map((v) => JSON.stringify(v))).size !== result.length) throw new TypeError('Evidencias duplicadas');
  return result;
}
export function validFile(file: FileMetadata): boolean {
  return Boolean(file && validText(file.nombre, 255) && !file.nombre.includes('/') && !file.nombre.includes('\\') && !hasControl(file.nombre) && validText(file.mime, 128) &&
    Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= 2147483647 && /^[a-f\d]{64}$/.test(file.sha256));
}
export function evidenceInput(evidence: Evidence[]): EvidenceInput[] {
  return canonicalEvidence(evidence.map((e) => e.tipo === 'enlace' ? { tipo: 'enlace', url: e.url } : { tipo: 'archivo', referencia: e.referencia }));
}
export function validSubmission(value: ProjectSubmission): boolean {
  if (!value || !(value.usuarioId instanceof Types.ObjectId) || !(value.cursoId instanceof Types.ObjectId) || !validText(value.solicitudId, 128) ||
    value.estado !== 'registrada' || !(value.fechaEntrega instanceof Date) || !Number.isFinite(value.fechaEntrega.getTime())) return false;
  try {
    evidenceInput(value.evidencias);
    return value.evidencias.every((e) => e.tipo === 'enlace' || (e.tipo === 'archivo' && validFile(e)));
  } catch { return false; }
}
/** Persistent insert slot, shared across processes and policy changes; not a timestamp. */
export function submissionSlot(user: Types.ObjectId, course: Types.ObjectId, ordinal: number): Types.ObjectId {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 2147483647) throw new RangeError('Cupo inválido');
  return new Types.ObjectId(createHash('sha256').update(`lethics:project-submission:v1:${user.toHexString()}:${course.toHexString()}:${ordinal}`).digest().subarray(0, 12));
}
