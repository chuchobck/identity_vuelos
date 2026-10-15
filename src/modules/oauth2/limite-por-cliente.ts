import { Inject, Injectable } from '@nestjs/common';
import { getStorageToken, ThrottlerStorage } from '@nestjs/throttler';
import { demasiadasPeticiones } from './errores-oauth';

/**
 * Límites de /oauth2/token. Un cliente legítimo pide un token cada 15 minutos (lo que dura) y
 * lo reutiliza: los topes son holgados para eso y cortos para quien prueba secretos.
 *
 * - porIp: con @LimiteEstricto, antes del controller.
 * - porCliente: por client_id presentado (exista o no), desde cualquier IP; frena a quien
 *   reparte intentos contra un mismo cliente entre muchas IP. Como contrapartida, quien conoce un
 *   client_id puede agotar su cupo un minuto (ver docs/PLAN.md, Pendientes).
 */
export const LIMITES_OAUTH2 = {
  porIp: { limite: 20, ventanaSegundos: 60 },
  porCliente: { limite: 10, ventanaSegundos: 60 },
} as const;

/** Nombre del contador en el almacén de límites (el mismo AlmacenLimites, con el Reloj). */
const CONTADOR = 'oauth2-cliente';

@Injectable()
export class LimitePorCliente {
  constructor(@Inject(getStorageToken()) private readonly almacen: ThrottlerStorage) {}

  /** Cuenta un intento del client_id; si se pasó del límite, lanza 429 con Retry-After. */
  async exigir(clientId: string): Promise<void> {
    const { limite, ventanaSegundos } = LIMITES_OAUTH2.porCliente;
    const registro = await this.almacen.increment(
      clientId,
      ventanaSegundos * 1000,
      limite,
      0,
      CONTADOR,
    );
    if (registro.isBlocked) {
      throw demasiadasPeticiones(Math.max(1, registro.timeToBlockExpire || ventanaSegundos));
    }
  }
}
