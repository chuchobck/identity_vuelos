import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Lo que cualquier capa necesita saber de la petición en curso sin recibirlo como parámetro:
 * el logger lo imprime y la auditoría de seguridad lo guarda.
 */
export interface ContextoPeticion {
  /** X-Request-Id: el que mandó el cliente si tenía un formato válido, o uno generado. */
  requestId: string;
  /** X-Correlation-Id: el del cliente si es válido o uno generado (contrato v2, §6). */
  correlationId: string;
  /** IP del cliente (con `trust proxy` configurado, la de X-Forwarded-For). */
  ip: string | null;
  /**
   * Quién hace la petición, si ya se sabe: el `sub` de un token válido (JwtAuthGuard), el
   * usuario cuya contraseña se acaba de verificar o el cliente OAuth autenticado. null en una
   * petición anónima. Va al log de acceso; nunca un correo ni un token.
   */
  usuario: string | null;
}

const almacen = new AsyncLocalStorage<ContextoPeticion>();

/** El contexto de la petición en curso, o `undefined` fuera de una petición (arranque, CLI). */
export function obtenerContexto(): ContextoPeticion | undefined {
  return almacen.getStore();
}

/** Corre `trabajo` con `contexto` visible desde `obtenerContexto()`, también tras cada `await`. */
export function ejecutarEnContexto<T>(contexto: ContextoPeticion, trabajo: () => T): T {
  return almacen.run(contexto, trabajo);
}

/** Registra en el contexto quién hace la petición (un uuid: usuario o cliente OAuth). */
export function fijarUsuario(usuario: string): void {
  const contexto = almacen.getStore();
  if (contexto) contexto.usuario = usuario;
}

/** `::ffff:203.0.113.7` (IPv4 dentro de IPv6) → `203.0.113.7`; lo demás queda igual. */
export function normalizarIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return ip.replace(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i, '$1');
}
