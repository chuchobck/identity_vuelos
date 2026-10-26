import { ClienteIdentidad } from '../../../prisma/prisma.service';
import { ContrasenaService } from '../../auth/seguridad/contrasena.service';
import { generarSecretoCliente } from './alta-cliente';

/** El cliente no existe o está dado de baja. El mensaje no repite lo que escribió quien opera. */
export class RotacionInvalida extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'RotacionInvalida';
  }
}

export interface SecretoRotado {
  clientId: string;
  /** El secreto nuevo en claro. Se muestra una sola vez: en la base queda su hash argon2id. */
  secreto: string;
}

/**
 * Cambia el secreto de un cliente activo SIN cambiar su client_id, sus scopes ni su `sub`
 * (el core reconoce al partner por el client_id del token). El secreto anterior deja de servir
 * en el acto: quien lo usa tiene que recibir el nuevo antes de que pida su próximo token. Los
 * tokens ya emitidos siguen valiendo hasta que vencen (15 minutos).
 *
 * El UPDATE y el evento CLIENTE_SECRETO_ROTADO van en una transacción. Lo usa
 * `npm run cliente:rotar-secreto`; no hay endpoint que lo haga.
 */
export async function rotarSecretoCliente(
  db: ClienteIdentidad,
  clientId: string,
  contrasenas = new ContrasenaService(),
): Promise<SecretoRotado> {
  const secreto = generarSecretoCliente();
  const hash = await contrasenas.hashear(secreto);
  const actualizado = await db.$transaction(async (tx) => {
    const { count } = await tx.cliente_oauth.updateMany({
      where: { codigo: clientId, activo: true },
      data: { hash_secreto: hash },
    });
    if (count === 0) return false;
    const fila = await tx.cliente_oauth.findUniqueOrThrow({
      where: { codigo: clientId },
      select: { id: true },
    });
    await tx.auditoria_seguridad.create({
      data: { evento: 'CLIENTE_SECRETO_ROTADO', resultado: 'EXITO', cliente_id: fila.id },
      select: { id: true },
    });
    return true;
  });
  if (!actualizado) throw new RotacionInvalida('--client-id no es un cliente activo');
  return { clientId, secreto };
}
