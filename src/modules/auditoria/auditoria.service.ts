import { Injectable, Logger } from '@nestjs/common';
import { obtenerContexto } from '../../common/contexto/contexto-peticion';
import { esRequestIdValido } from '../../common/contexto/request-id';
import { evento_seguridad, resultado_seguridad } from '../../generated/prisma/client';
import { resumirError } from '../../prisma/prisma.service';
import { AuditoriaRepository } from './auditoria.repository';

/**
 * Por qué terminó así un evento. Lista cerrada: un motivo es un código corto, nunca texto libre
 * (que podría llevar un correo o un token). La base lo exige con ck_auditoria_seguridad_motivo.
 */
export type MotivoSeguridad =
  // login y registro
  | 'CORREO_DESCONOCIDO'
  | 'CONTRASENA_INVALIDA'
  | 'CUENTA_INACTIVA'
  | 'CORREO_REGISTRADO'
  // refresh y logout
  | 'TOKEN_DESCONOCIDO'
  | 'TOKEN_VENCIDO'
  | 'TOKEN_REVOCADO'
  | 'TOKEN_AJENO'
  | 'REUTILIZACION'
  | 'CARRERA'
  // client_credentials
  | 'CLIENTE_DESCONOCIDO'
  | 'SECRETO_INVALIDO'
  | 'CLIENTE_INACTIVO'
  | 'SCOPE_NO_PERMITIDO'
  | 'GRANT_NO_SOPORTADO'
  | 'PETICION_INVALIDA';

export interface EventoSeguridad {
  evento: evento_seguridad;
  resultado: resultado_seguridad;
  motivo?: MotivoSeguridad;
  /** usuario.id, si el evento es de una cuenta que existe. */
  usuarioId?: string;
  /** cliente_oauth.id, si el evento es de un cliente que existe. */
  clienteId?: string;
  /**
   * El correo que se intentó usar, solo cuando no corresponde a ninguna cuenta. Se guarda
   * parcial (an***@dominio.ec): nunca el correo completo.
   */
  correoIntentado?: string;
}

/**
 * Deja cada evento de seguridad en auditoria_seguridad, con la IP y el X-Request-Id de la
 * petición en curso (para cruzarlo con los logs).
 *
 * Va fuera de las transacciones de negocio: un login fallido o una reutilización revertida
 * igual quedan registrados. Si la escritura falla, se anota en el log (sin datos) y la petición
 * sigue: la auditoría no tumba un login.
 */
@Injectable()
export class AuditoriaSeguridad {
  private readonly logger = new Logger(AuditoriaSeguridad.name);

  constructor(private readonly repositorio: AuditoriaRepository) {}

  async registrar(evento: EventoSeguridad): Promise<void> {
    const contexto = obtenerContexto();
    try {
      await this.repositorio.insertar({
        evento: evento.evento,
        resultado: evento.resultado,
        motivo: evento.motivo ?? null,
        usuario_id: evento.usuarioId ?? null,
        cliente_id: evento.clienteId ?? null,
        correo_parcial:
          evento.correoIntentado === undefined ? null : enmascararCorreo(evento.correoIntentado),
        direccion_ip: contexto?.ip ?? null,
        id_peticion: contexto && esRequestIdValido(contexto.requestId) ? contexto.requestId : null,
      });
    } catch (error) {
      this.logger.error(
        `No se pudo registrar el evento ${evento.evento} ${evento.resultado}: ${resumirError(error)}`,
      );
    }
  }
}

/**
 * `ana.perez@correo.ec` → `an***@correo.ec`. A lo sumo dos caracteres de la parte local: sirve
 * para ver que alguien prueba la misma cuenta una y otra vez sin guardar el correo. Un texto sin
 * `@` (no puede pasar: el DTO valida el correo) queda como `***@-`.
 */
export function enmascararCorreo(correo: string): string {
  const arroba = correo.lastIndexOf('@');
  if (arroba < 1) return '***@-';
  const local = correo.slice(0, arroba);
  const dominio = correo.slice(arroba + 1).replace(/[@\s]/g, '') || '-';
  const visibles = local.length > 4 ? 2 : local.length > 1 ? 1 : 0;
  return `${local.slice(0, visibles).replace(/\s/g, '')}***@${dominio}`;
}
