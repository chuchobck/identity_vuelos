import { SpanKind } from '@opentelemetry/api';
import { Injectable } from '@nestjs/common';
import { ErrorNegocio } from '../common/errores/error-negocio';
import { ErrorOAuth } from '../modules/oauth2/errores-oauth';
import { Counter } from 'prom-client';
import { Metricas } from './metricas';
import { camposDeTraza, marcarError, Trazas } from './trazas';

/** Resultado de un login: lista cerrada (cardinalidad acotada). */
export type ResultadoLogin = 'success' | 'invalid_credentials' | 'inactive_account';

/** Tipo de token de acceso emitido: lista cerrada. */
export type TipoTokenEmitido = 'user_login' | 'user_refresh' | 'client_credentials';

/**
 * Los spans manuales y las métricas propias de identity (docs/OBSERVABILIDAD.md: las específicas
 * llevan su prefijo, `identity_`, y las mismas reglas de cardinalidad). Nunca un correo, un id
 * de usuario o de cliente, un client_id, una IP ni un token en una etiqueta o un atributo.
 */
@Injectable()
export class Observabilidad {
  readonly logins: Counter<'result'>;
  readonly tokensEmitidos: Counter<'type'>;

  constructor(
    readonly trazas: Trazas,
    readonly metricas: Metricas,
  ) {
    this.logins = new Counter({
      name: 'identity_logins_total',
      help: 'Intentos de login de personas, por resultado',
      labelNames: ['result'] as const,
      registers: [metricas.registro],
    });
    this.tokensEmitidos = new Counter({
      name: 'identity_tokens_issued_total',
      help: 'Tokens de acceso emitidos, por tipo',
      labelNames: ['type'] as const,
      registers: [metricas.registro],
    });
    // Las series existen desde el arranque, en cero: una consulta no depende de que ya haya pasado
    for (const resultado of ['success', 'invalid_credentials', 'inactive_account'] as const) {
      this.logins.labels(resultado).inc(0);
    }
    for (const tipo of ['user_login', 'user_refresh', 'client_credentials'] as const) {
      this.tokensEmitidos.labels(tipo).inc(0);
    }
  }

  login(resultado: ResultadoLogin): void {
    this.logins.labels(resultado).inc();
  }

  tokenEmitido(tipo: TipoTokenEmitido): void {
    this.tokensEmitidos.labels(tipo).inc();
  }

  /**
   * Un span INTERNAL para un trabajo con duración propia (`auth.login`, `auth.refresh`,
   * `oauth2.token`), hijo del span SERVER de la petición. Solo un fallo inesperado (no un 4xx de
   * negocio, que es del cliente) lo marca como error, y con `error.type`, nunca el mensaje.
   */
  async span<T>(nombre: string, trabajo: () => Promise<T>): Promise<T> {
    const span = this.trazas.iniciar(nombre, SpanKind.INTERNAL, {
      'quinde.request_id': camposDeTraza().requestId,
    });
    try {
      return await this.trazas.conSpan(span, trabajo);
    } catch (error) {
      const status =
        error instanceof ErrorNegocio || error instanceof ErrorOAuth ? error.status : 500;
      if (status >= 500) marcarError(span, status >= 500 && status <= 504 ? String(status) : '500');
      throw error;
    } finally {
      span.end();
    }
  }
}
