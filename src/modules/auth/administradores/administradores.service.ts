import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CODIGO_SIN_EQUIVALENTE } from '../../../common/errores/codigo-error';
import { ErrorNegocio } from '../../../common/errores/error-negocio';
import { traducirErrorBd } from '../../../common/errores/traducir-error-bd';
import {
  codificarCursor,
  cursorInvalido,
  decodificarCursor,
  LIMITE_POR_DEFECTO,
  noEncontrado,
} from '../../../common/paginacion/paginacion';
import { esUuid } from '../../../common/pipes/formatos';
import { Reloj } from '../../../common/reloj';
import { AuditoriaSeguridad, MotivoSeguridad } from '../../auditoria/auditoria.service';
import { AuthRepository, UsuarioConRoles } from '../auth.repository';
import { ROL_ADMINISTRADOR } from '../scopes';
import { ContrasenaService } from '../seguridad/contrasena.service';
import { ConsultaAdministradoresDto, CrearAdministradorDto } from './dto/administrador.dto';
import { AdministradoresRepository, FilaAdministrador } from './administradores.repository';

/**
 * Altas, lista y bajas de administradores: las reglas del AdministradoresService del core,
 * copiadas tal cual. No tiene lógica de seguridad propia: el hash es el de ContrasenaService
 * (mismos parámetros argon2id que el registro) y el alta es la de AuthRepository, con el rol
 * fijado aquí.
 *
 * Lo que cambia es la auditoría: en lugar de la tabla de cambios del core, cada alta y cada
 * baja deja un evento en auditoria_seguridad con el `sub` del administrador que la pidió
 * (actor_id) y la cuenta afectada (usuario_id), en la misma transacción que el cambio. Un
 * intento rechazado (correo repetido, la propia cuenta, el último administrador) también queda,
 * como FALLO y con su motivo. Nunca la contraseña, su hash ni el correo.
 */
@Injectable()
export class AdministradoresService {
  constructor(
    private readonly auth: AuthRepository,
    private readonly contrasenas: ContrasenaService,
    private readonly repositorio: AdministradoresRepository,
    private readonly auditoria: AuditoriaSeguridad,
    private readonly reloj: Reloj,
  ) {}

  /**
   * Crea un usuario con el rol administrador. Un correo repetido falla por uq_usuario_correo y
   * el filtro de errores lo responde como 409.
   */
  async crear(dto: CrearAdministradorDto, idSolicitante: string): Promise<UsuarioConRoles> {
    const id = randomUUID();
    const hash = await this.contrasenas.hashear(dto.password);
    try {
      return await this.auth.crearUsuario(id, dto.email, hash, ROL_ADMINISTRADOR, (tx) =>
        this.auditoria.registrarEn(tx, {
          evento: 'ADMINISTRADOR_CREADO',
          resultado: 'EXITO',
          usuarioId: id,
          actorId: idSolicitante,
        }),
      );
    } catch (error) {
      if (traducirErrorBd(error)?.status === 409) {
        const existente = await this.auth.idPorCorreo(dto.email);
        await this.auditoria.registrar({
          evento: 'ADMINISTRADOR_CREADO',
          resultado: 'FALLO',
          motivo: 'CORREO_REGISTRADO',
          usuarioId: existente ?? undefined,
          actorId: idSolicitante,
        });
      }
      throw error;
    }
  }

  async listar(
    consulta: ConsultaAdministradoresDto,
  ): Promise<{ filas: FilaAdministrador[]; nextCursor?: string }> {
    const limite = consulta.limit ?? LIMITE_POR_DEFECTO;
    const filas = await this.repositorio.listar({
      incluirInactivos: consulta.includeInactive ?? false,
      despuesDe: consulta.cursor ? leerCursor(consulta.cursor) : undefined,
      limite,
    });
    if (filas.length <= limite) return { filas };
    const ultima = filas[limite - 1];
    return {
      filas: filas.slice(0, limite),
      nextCursor: codificarCursor(`${ultima.fechaCreacion.toISOString()}|${ultima.id}`),
    };
  }

  /**
   * Baja lógica. 404 si no existe o no es administrador; 409 si es el propio solicitante o el
   * último administrador activo; repetirla sobre quien ya estaba de baja responde igual (204).
   */
  async darDeBaja(id: string, idSolicitante: string): Promise<void> {
    const resultado = await this.repositorio.baja(id, idSolicitante, this.reloj.ahora(), (tx) =>
      this.auditoria.registrarEn(tx, {
        evento: 'ADMINISTRADOR_DADO_DE_BAJA',
        resultado: 'EXITO',
        usuarioId: id,
        actorId: idSolicitante,
      }),
    );
    if (resultado === 'no-existe') throw noEncontrado('Administrator', id);
    if (resultado === 'es-el-mismo') {
      await this.rechazoDeBaja(id, idSolicitante, 'PROPIA_CUENTA');
      throw new ErrorNegocio(
        409,
        CODIGO_SIN_EQUIVALENTE,
        'You cannot deactivate your own account; ask another administrator',
      );
    }
    if (resultado === 'es-el-ultimo') {
      await this.rechazoDeBaja(id, idSolicitante, 'ULTIMO_ADMINISTRADOR');
      throw new ErrorNegocio(
        409,
        CODIGO_SIN_EQUIVALENTE,
        'The last active administrator cannot be deactivated',
      );
    }
  }

  private rechazoDeBaja(id: string, idSolicitante: string, motivo: MotivoSeguridad) {
    return this.auditoria.registrar({
      evento: 'ADMINISTRADOR_DADO_DE_BAJA',
      resultado: 'FALLO',
      motivo,
      usuarioId: id,
      actorId: idSolicitante,
    });
  }
}

/** El cursor de la lista: `creación|id`. Cualquier otro texto es 400. */
function leerCursor(cursor: string): { creada: Date; id: string } {
  const [creada, id, ...resto] = (decodificarCursor(cursor) ?? '').split('|');
  const fecha = new Date(creada);
  if (resto.length > 0 || Number.isNaN(fecha.getTime()) || !esUuid(id)) throw cursorInvalido();
  return { creada: fecha, id };
}
