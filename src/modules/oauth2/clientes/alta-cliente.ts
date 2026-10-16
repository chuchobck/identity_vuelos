import { randomBytes } from 'node:crypto';
import { tieneCaracteresDeControl, tieneEtiquetasHtml } from '../../../common/sanitizacion/texto';
import { ClienteIdentidad } from '../../../prisma/prisma.service';
import { esScope, Scope, SCOPE_ADMINISTRACION, SCOPE_EVENTOS, SCOPES } from '../../auth/scopes';
import { ContrasenaService } from '../../auth/seguridad/contrasena.service';

/** Formato de un client_id: el mismo que exige ck_cliente_oauth_codigo en la base. */
export const FORMATO_CLIENT_ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;

export interface DatosAltaCliente {
  nombre: string;
  /** Scopes permitidos, como texto separado por espacios o comas. */
  scopes: string;
  /** client_id elegido; sin él se genera uno (`cli-` y 20 caracteres hexadecimales). */
  clientId?: string;
  /** Sin esto, pedir flights:admin es un error: un cliente nunca lo recibe por descuido. */
  permitirAdmin?: boolean;
  /** Lo mismo con events:publish: solo un servicio que publica eventos lo tiene permitido. */
  permitirEventos?: boolean;
}

export interface ClienteCreado {
  id: string;
  clientId: string;
  /** El secreto en claro. Se muestra una sola vez: en la base queda solo su hash argon2id. */
  secreto: string;
  scopes: Scope[];
}

/** Datos del alta que no sirven. El mensaje no repite el valor. */
export class AltaClienteInvalida extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'AltaClienteInvalida';
  }
}

/** Revisa y normaliza los datos del alta; lanza AltaClienteInvalida si algo no sirve. */
export function validarAltaCliente(datos: DatosAltaCliente): {
  nombre: string;
  clientId: string;
  scopes: Scope[];
} {
  const nombre = datos.nombre.trim().normalize('NFC');
  if (nombre === '' || nombre.length > 100) {
    throw new AltaClienteInvalida('--nombre es obligatorio y admite hasta 100 caracteres');
  }
  if (tieneCaracteresDeControl(nombre) || tieneEtiquetasHtml(nombre)) {
    throw new AltaClienteInvalida('--nombre no puede tener caracteres de control ni HTML');
  }

  const pedidos = datos.scopes.split(/[\s,]+/).filter((scope) => scope !== '');
  if (pedidos.length === 0) {
    throw new AltaClienteInvalida(`--scopes es obligatorio; los posibles: ${SCOPES.join(' ')}`);
  }
  const desconocidos = pedidos.filter((scope) => !esScope(scope));
  if (desconocidos.length > 0) {
    throw new AltaClienteInvalida(`--scopes trae scopes que no existen: ${desconocidos.join(' ')}`);
  }
  if (pedidos.includes(SCOPE_ADMINISTRACION) && !datos.permitirAdmin) {
    throw new AltaClienteInvalida(
      `${SCOPE_ADMINISTRACION} solo se permite con --permitir-admin (un cliente de administración)`,
    );
  }
  if (pedidos.includes(SCOPE_EVENTOS) && !datos.permitirEventos) {
    throw new AltaClienteInvalida(
      `${SCOPE_EVENTOS} solo se permite con --permitir-eventos (un servicio que publica eventos)`,
    );
  }
  const scopes = SCOPES.filter((scope) => pedidos.includes(scope));

  const clientId = datos.clientId ?? `cli-${randomBytes(10).toString('hex')}`;
  if (!FORMATO_CLIENT_ID.test(clientId)) {
    throw new AltaClienteInvalida(
      '--client-id debe tener de 3 a 64 caracteres: minúsculas, dígitos, punto, guion o guion bajo',
    );
  }
  return { nombre, clientId, scopes };
}

/** 256 bits aleatorios en base64url (43 caracteres), como los tokens de refresco. */
export function generarSecretoCliente(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Crea el cliente y deja el evento CLIENTE_CREADO en la auditoría, en una transacción. Lo usan
 * `npm run cliente:crear` y las pruebas; no hay endpoint que lo haga.
 */
export async function crearCliente(
  db: ClienteIdentidad,
  datos: DatosAltaCliente,
  contrasenas = new ContrasenaService(),
): Promise<ClienteCreado> {
  const { nombre, clientId, scopes } = validarAltaCliente(datos);
  const secreto = generarSecretoCliente();
  const hash = await contrasenas.hashear(secreto);
  const id = await db.$transaction(async (tx) => {
    const creado = await tx.cliente_oauth.create({
      data: { codigo: clientId, nombre, hash_secreto: hash, scopes_permitidos: scopes },
      select: { id: true },
    });
    await tx.auditoria_seguridad.create({
      data: { evento: 'CLIENTE_CREADO', resultado: 'EXITO', cliente_id: creado.id },
      select: { id: true },
    });
    return creado.id;
  });
  return { id, clientId, secreto, scopes };
}
