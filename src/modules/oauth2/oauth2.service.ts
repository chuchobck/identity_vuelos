import { Injectable } from '@nestjs/common';
import { fijarUsuario } from '../../common/contexto/contexto-peticion';
import { AuditoriaSeguridad, MotivoSeguridad } from '../auditoria/auditoria.service';
import { esScope, Scope, SCOPE_ADMINISTRACION, SCOPES } from '../auth/scopes';
import { ContrasenaService } from '../auth/seguridad/contrasena.service';
import { TokensService } from '../claves/tokens.service';
import { FORMATO_CLIENT_ID } from './clientes/alta-cliente';
import { ClienteOAuth, ClientesRepository } from './clientes/clientes.repository';
import { TokenClienteRespuestaDto } from './dto/token-cliente.dto';
import { clienteInvalido, ErrorOAuth, scopeInvalido } from './errores-oauth';
import { LimitePorCliente } from './limite-por-cliente';
import { leerPeticionToken, PeticionToken, PeticionTokenInvalida } from './peticion-token';

/**
 * El grant client_credentials (RFC 6749, sección 4.4): un sistema se autentica con su client_id
 * y su secreto y recibe un token de acceso de 15 minutos, sin token de refresco (cuando vence,
 * pide otro). El `sub` es el uuid del cliente (el core exige un uuid) y el token lleva además
 * `client_id`. Cada intento, bueno o malo, queda en auditoria_seguridad.
 */
@Injectable()
export class OAuth2Service {
  constructor(
    private readonly clientes: ClientesRepository,
    private readonly contrasenas: ContrasenaService,
    private readonly tokens: TokensService,
    private readonly auditoria: AuditoriaSeguridad,
    private readonly limite: LimitePorCliente,
  ) {}

  async emitirToken(
    cuerpo: unknown,
    autorizacion: string | undefined,
  ): Promise<TokenClienteRespuestaDto> {
    let peticion: PeticionToken;
    try {
      peticion = leerPeticionToken(cuerpo, autorizacion);
    } catch (error) {
      if (!(error instanceof PeticionTokenInvalida)) throw error;
      await this.fallo(error.motivo);
      throw error.error;
    }

    const { clientId, secreto } = peticion.credenciales;
    try {
      await this.limite.exigir(clientId);
    } catch (error) {
      // Sin el id del cliente: todavía no se sabe si el client_id presentado existe
      if (error instanceof ErrorOAuth) await this.fallo('LIMITE_EXCEDIDO');
      throw error;
    }

    const cliente = await this.autenticar(clientId, secreto);
    fijarUsuario(cliente.id);

    let scopes: Scope[];
    try {
      scopes = scopesConcedidos(cliente, peticion.scope);
    } catch (error) {
      if (error instanceof ErrorOAuth) await this.fallo('SCOPE_NO_PERMITIDO', cliente.id);
      throw error;
    }

    const acceso = await this.tokens.emitir({ sub: cliente.id, scopes, clientId: cliente.codigo });
    await this.auditoria.registrar({
      evento: 'TOKEN_CLIENTE',
      resultado: 'EXITO',
      clienteId: cliente.id,
    });
    return {
      access_token: acceso.token,
      token_type: 'Bearer',
      expires_in: acceso.expiraEnSegundos,
      scope: scopes.join(' '),
    };
  }

  /**
   * Cliente desconocido, secreto errado y cliente inactivo responden igual y tardan lo mismo:
   * siempre se corre argon2, contra el hash ficticio si el cliente no existe.
   */
  private async autenticar(clientId: string, secreto: string): Promise<ClienteOAuth> {
    const cliente = FORMATO_CLIENT_ID.test(clientId)
      ? await this.clientes.buscarPorCodigo(clientId)
      : null;
    if (!cliente) {
      await this.contrasenas.verificarSinUsuario(secreto);
      await this.fallo('CLIENTE_DESCONOCIDO');
      throw clienteInvalido();
    }
    const valido = await this.contrasenas.verificar(cliente.hashSecreto, secreto);
    if (!valido || !cliente.activo) {
      await this.fallo(valido ? 'CLIENTE_INACTIVO' : 'SECRETO_INVALIDO', cliente.id);
      throw clienteInvalido();
    }
    return cliente;
  }

  private fallo(motivo: MotivoSeguridad, clienteId?: string): Promise<void> {
    return this.auditoria.registrar({
      evento: 'TOKEN_CLIENTE',
      resultado: 'FALLO',
      motivo,
      clienteId,
    });
  }
}

/**
 * Los scopes del token (RFC 6749, sección 3.3):
 *
 * - Con `scope`: todos los pedidos tienen que existir y estar permitidos al cliente; si uno no,
 *   invalid_scope (no se entrega un subconjunto en silencio).
 * - Sin `scope`: los permitidos, MENOS flights:admin. Ese scope solo sale si el cliente lo tiene
 *   permitido de forma explícita y además lo pide en esta petición.
 */
export function scopesConcedidos(cliente: ClienteOAuth, pedido: string | undefined): Scope[] {
  const permitidos = new Set(cliente.scopesPermitidos);
  if (pedido === undefined) {
    const porDefecto = SCOPES.filter(
      (scope) => scope !== SCOPE_ADMINISTRACION && permitidos.has(scope),
    );
    if (porDefecto.length === 0) {
      throw scopeInvalido('This client must request its scope explicitly');
    }
    return porDefecto;
  }

  const pedidos = pedido
    .trim()
    .split(/ +/)
    .filter((scope) => scope !== '');
  if (pedidos.length === 0) throw scopeInvalido('The scope parameter must not be empty');
  const fuera = pedidos.filter((scope) => !esScope(scope) || !permitidos.has(scope));
  if (fuera.length > 0) {
    // No repite lo pedido: el texto viene del cliente y se devuelve tal cual en el error
    throw scopeInvalido('The requested scope is unknown or not allowed for this client');
  }
  return SCOPES.filter((scope) => pedidos.includes(scope));
}
