import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { fijarUsuario } from '../../common/contexto/contexto-peticion';
import { traducirErrorBd } from '../../common/errores/traducir-error-bd';
import { Reloj } from '../../common/reloj';
import { Observabilidad, TipoTokenEmitido } from '../../observabilidad/observabilidad.service';
import { AuditoriaSeguridad } from '../auditoria/auditoria.service';
import { TokensService } from '../claves/tokens.service';
import { aTokenRespuesta } from './auth.mapper';
import { AuthRepository, TokenRefrescoGuardado, UsuarioConRoles } from './auth.repository';
import { LoginDto, RegistroDto } from './dto/credenciales.dto';
import { TokenRespuestaDto } from './dto/token-respuesta.dto';
import {
  credencialesInvalidas,
  desafioBearer,
  noAutenticado,
  refrescoInvalido,
} from './errores-auth';
import { ROL_DEL_REGISTRO, scopesDeRoles } from './scopes';
import { ContrasenaService } from './seguridad/contrasena.service';
import {
  generarTokenRefresco,
  hashearTokenRefresco,
  tieneFormatoDeTokenRefresco,
  VIGENCIA_REFRESCO_SEGUNDOS,
} from './seguridad/token-refresco';

/**
 * Cuentas de personas: las reglas del proveedor simulado del core, con tokens RS256 y cada
 * evento de seguridad en auditoria_seguridad. Ningún mensaje de log, de error ni fila de
 * auditoría lleva una contraseña, un hash, un token ni un correo completo: a lo sumo el id del
 * usuario o de la familia de tokens.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly repositorio: AuthRepository,
    private readonly contrasenas: ContrasenaService,
    private readonly tokens: TokensService,
    private readonly auditoria: AuditoriaSeguridad,
    private readonly reloj: Reloj,
    private readonly observabilidad: Observabilidad,
  ) {}

  /** Crea una cuenta con el rol de cliente. Un correo ya registrado responde 409. */
  async registrar(dto: RegistroDto): Promise<UsuarioConRoles> {
    const id = randomUUID();
    const hash = await this.contrasenas.hashear(dto.password);
    let usuario: UsuarioConRoles;
    try {
      usuario = await this.repositorio.crearUsuario(id, dto.email, hash, ROL_DEL_REGISTRO);
    } catch (error) {
      if (traducirErrorBd(error)?.status === 409) {
        const existente = await this.repositorio.idPorCorreo(dto.email);
        await this.auditoria.registrar({
          evento: 'REGISTRO',
          resultado: 'FALLO',
          motivo: 'CORREO_REGISTRADO',
          usuarioId: existente ?? undefined,
        });
      }
      throw error;
    }
    fijarUsuario(usuario.id);
    await this.auditoria.registrar({ evento: 'REGISTRO', resultado: 'EXITO', usuarioId: id });
    return usuario;
  }

  /**
   * Correo inexistente, contraseña errónea y cuenta inactiva responden igual y tardan lo
   * mismo: siempre se corre argon2, contra el hash ficticio si el correo no existe, y siempre
   * se escribe una fila de auditoría.
   */
  iniciarSesion(dto: LoginDto): Promise<TokenRespuestaDto> {
    return this.observabilidad.span('auth.login', () => this.iniciarSesionConSpan(dto));
  }

  private async iniciarSesionConSpan(dto: LoginDto): Promise<TokenRespuestaDto> {
    const usuario = await this.repositorio.buscarPorCorreo(dto.email);
    if (!usuario) {
      await this.contrasenas.verificarSinUsuario(dto.password);
      this.observabilidad.login('invalid_credentials');
      await this.auditoria.registrar({
        evento: 'LOGIN',
        resultado: 'FALLO',
        motivo: 'CORREO_DESCONOCIDO',
        correoIntentado: dto.email,
      });
      throw credencialesInvalidas();
    }
    const valida = await this.contrasenas.verificar(usuario.hashContrasena, dto.password);
    if (!valida || !usuario.activo) {
      this.observabilidad.login(valida ? 'inactive_account' : 'invalid_credentials');
      await this.auditoria.registrar({
        evento: 'LOGIN',
        resultado: 'FALLO',
        motivo: valida ? 'CUENTA_INACTIVA' : 'CONTRASENA_INVALIDA',
        usuarioId: usuario.id,
      });
      throw credencialesInvalidas();
    }

    fijarUsuario(usuario.id);
    if (this.contrasenas.necesitaRehash(usuario.hashContrasena)) {
      await this.repositorio.actualizarHashContrasena(
        usuario.id,
        await this.contrasenas.hashear(dto.password),
      );
    }

    // Cada login abre una familia nueva de tokens de refresco
    const refresco = generarTokenRefresco();
    await this.repositorio.crearTokenRefresco({
      usuarioId: usuario.id,
      idFamilia: randomUUID(),
      hash: refresco.hash,
      ...this.vigenciaRefresco(),
    });
    await this.auditoria.registrar({ evento: 'LOGIN', resultado: 'EXITO', usuarioId: usuario.id });
    this.observabilidad.login('success');
    return this.respuesta(usuario, refresco.token, 'user_login');
  }

  /**
   * Rotación: el token usado queda marcado como reemplazado y se entrega uno nuevo de la
   * misma familia. Si llega uno que ya fue reemplazado, alguien más lo tiene: se revoca la
   * familia completa y el dueño tiene que volver a iniciar sesión.
   */
  refrescar(token: string): Promise<TokenRespuestaDto> {
    return this.observabilidad.span('auth.refresh', () => this.refrescarConSpan(token));
  }

  private async refrescarConSpan(token: string): Promise<TokenRespuestaDto> {
    const guardado = tieneFormatoDeTokenRefresco(token)
      ? await this.repositorio.buscarTokenRefresco(hashearTokenRefresco(token))
      : null;
    if (!guardado) {
      await this.fallaRefresco('TOKEN_DESCONOCIDO');
      throw refrescoInvalido();
    }
    if (guardado.revocado) {
      await this.fallaRefresco('TOKEN_REVOCADO', guardado.usuario.id);
      throw refrescoInvalido();
    }
    if (guardado.fechaExpiracion <= this.reloj.ahora()) {
      await this.fallaRefresco('TOKEN_VENCIDO', guardado.usuario.id);
      throw refrescoInvalido();
    }
    if (guardado.reemplazado) {
      await this.revocarPorReutilizacion(guardado, 'REUTILIZACION');
      throw refrescoInvalido();
    }
    if (!guardado.usuario.activo) {
      await this.repositorio.revocarFamilia(
        guardado.idFamilia,
        'USUARIO_INACTIVO',
        this.reloj.ahora(),
      );
      await this.fallaRefresco('CUENTA_INACTIVA', guardado.usuario.id);
      throw refrescoInvalido();
    }

    fijarUsuario(guardado.usuario.id);
    const nuevo = generarTokenRefresco();
    const rotado = await this.repositorio.rotarTokenRefresco(guardado.id, {
      usuarioId: guardado.usuario.id,
      idFamilia: guardado.idFamilia,
      hash: nuevo.hash,
      ...this.vigenciaRefresco(),
    });
    // Otro refresh con el mismo token ganó la carrera: es una reutilización
    if (!rotado) {
      await this.revocarPorReutilizacion(guardado, 'CARRERA');
      throw refrescoInvalido();
    }
    await this.auditoria.registrar({
      evento: 'REFRESCO',
      resultado: 'EXITO',
      usuarioId: guardado.usuario.id,
    });
    return this.respuesta(guardado.usuario, nuevo.token, 'user_refresh');
  }

  /**
   * Revoca la familia del token de refresco si es del usuario que llama. Siempre termina
   * bien (204): un token ajeno, vencido o desconocido no se distingue de uno válido. El token
   * de acceso sigue sirviendo hasta que vence (15 minutos): es un JWT y no se revoca.
   */
  async cerrarSesion(usuarioId: string, token: string): Promise<void> {
    const guardado = tieneFormatoDeTokenRefresco(token)
      ? await this.repositorio.buscarTokenRefresco(hashearTokenRefresco(token))
      : null;
    if (!guardado || guardado.usuario.id !== usuarioId) {
      await this.auditoria.registrar({
        evento: 'LOGOUT',
        resultado: 'FALLO',
        motivo: guardado ? 'TOKEN_AJENO' : 'TOKEN_DESCONOCIDO',
        usuarioId,
      });
      return;
    }
    await this.repositorio.revocarFamilia(guardado.idFamilia, 'CIERRE_SESION', this.reloj.ahora());
    await this.auditoria.registrar({ evento: 'LOGOUT', resultado: 'EXITO', usuarioId });
  }

  /** Perfil del usuario del token. Una cuenta desactivada después del login responde 401. */
  async perfil(usuarioId: string): Promise<UsuarioConRoles> {
    const usuario = await this.repositorio.buscarPorId(usuarioId);
    if (!usuario || !usuario.activo) {
      if (usuario) {
        await this.auditoria.registrar({
          evento: 'ACCESO_CUENTA_INACTIVA',
          resultado: 'FALLO',
          motivo: 'CUENTA_INACTIVA',
          usuarioId,
        });
      }
      const detalle = 'The account is not active';
      throw noAutenticado(detalle, desafioBearer('invalid_token', detalle));
    }
    return usuario;
  }

  private async revocarPorReutilizacion(
    guardado: TokenRefrescoGuardado,
    motivo: 'REUTILIZACION' | 'CARRERA',
  ): Promise<void> {
    const revocados = await this.repositorio.revocarFamilia(
      guardado.idFamilia,
      'REUTILIZACION',
      this.reloj.ahora(),
    );
    await this.auditoria.registrar({
      evento: 'REUSO_REFRESCO',
      resultado: 'FALLO',
      motivo,
      usuarioId: guardado.usuario.id,
    });
    this.logger.warn(
      `Reutilización de un token de refresco ya rotado: se revocó la familia ${guardado.idFamilia} ` +
        `(${revocados} tokens sin revocar) del usuario ${guardado.usuario.id}`,
    );
  }

  private fallaRefresco(
    motivo: 'TOKEN_DESCONOCIDO' | 'TOKEN_REVOCADO' | 'TOKEN_VENCIDO' | 'CUENTA_INACTIVA',
    usuarioId?: string,
  ): Promise<void> {
    return this.auditoria.registrar({ evento: 'REFRESCO', resultado: 'FALLO', motivo, usuarioId });
  }

  private vigenciaRefresco(): { fechaCreacion: Date; fechaExpiracion: Date } {
    const ahora = this.reloj.ahora();
    return {
      fechaCreacion: ahora,
      fechaExpiracion: new Date(ahora.getTime() + VIGENCIA_REFRESCO_SEGUNDOS * 1000),
    };
  }

  /** Los scopes se recalculan en cada login y refresh: un cambio de rol entra en el siguiente. */
  private async respuesta(
    usuario: UsuarioConRoles,
    tokenRefresco: string,
    tipo: TipoTokenEmitido,
  ): Promise<TokenRespuestaDto> {
    const scopes = scopesDeRoles(usuario.roles);
    const acceso = await this.tokens.emitir({ sub: usuario.id, scopes });
    this.observabilidad.tokenEmitido(tipo);
    return aTokenRespuesta({
      tokenAcceso: acceso.token,
      expiraEnSegundos: acceso.expiraEnSegundos,
      tokenRefresco,
      scopes,
    });
  }
}
