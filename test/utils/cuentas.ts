import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuthService } from '../../src/modules/auth/auth.service';
import { TokenRespuestaDto } from '../../src/modules/auth/dto/token-respuesta.dto';
import {
  ClienteCreado,
  crearCliente,
  DatosAltaCliente,
} from '../../src/modules/oauth2/clientes/alta-cliente';
import { PrismaService } from '../../src/prisma/prisma.service';

/** Dominio reservado (RFC 2606) de las cuentas que crean las pruebas. */
export const DOMINIO_PRUEBAS = 'e2e.quinde.example';

/** Prefijo de los client_id que crean las pruebas. */
export const PREFIJO_CLIENTES_PRUEBA = 'e2e-';

export const CONTRASENA_PRUEBA = 'una frase de prueba bastante larga';

export interface UsuarioDePrueba {
  id: string;
  correo: string;
  contrasena: string;
}

export function correoDePrueba(): string {
  return `e2e-${randomUUID()}@${DOMINIO_PRUEBAS}`;
}

/**
 * Crea una cuenta con el service, sin pasar por HTTP: así la preparación de una prueba no
 * gasta el límite de /auth/register. Con `administrador` le suma ese rol.
 */
export async function crearUsuario(
  app: INestApplication,
  opciones: { administrador?: boolean; contrasena?: string } = {},
): Promise<UsuarioDePrueba> {
  const correo = correoDePrueba();
  const contrasena = opciones.contrasena ?? CONTRASENA_PRUEBA;
  const usuario = await app.get(AuthService).registrar({ email: correo, password: contrasena });
  if (opciones.administrador) {
    const prisma = app.get(PrismaService);
    const rol = await prisma.db.rol.findUniqueOrThrow({ where: { codigo: 'administrador' } });
    await prisma.db.usuario_rol.create({ data: { usuario_id: usuario.id, rol_id: rol.id } });
  }
  return { id: usuario.id, correo, contrasena };
}

/** Login con el service (sin el límite de /auth/login). */
export function iniciarSesion(
  app: INestApplication,
  usuario: UsuarioDePrueba,
): Promise<TokenRespuestaDto> {
  return app
    .get(AuthService)
    .iniciarSesion({ email: usuario.correo, password: usuario.contrasena });
}

export async function desactivarUsuario(
  app: INestApplication,
  usuario: { id: string },
): Promise<void> {
  await app
    .get(PrismaService)
    .db.usuario.update({ where: { id: usuario.id }, data: { activo: false } });
}

/** Un cliente OAuth con client_id de prueba (e2e-...). */
export function crearClienteDePrueba(
  app: INestApplication,
  datos: Partial<DatosAltaCliente> & { scopes: string },
): Promise<ClienteCreado> {
  return crearCliente(app.get(PrismaService).db, {
    nombre: 'Cliente de prueba',
    clientId: `${PREFIJO_CLIENTES_PRUEBA}${randomUUID().slice(0, 18)}`,
    ...datos,
  });
}

export async function desactivarCliente(
  app: INestApplication,
  cliente: { id: string },
): Promise<void> {
  await app
    .get(PrismaService)
    .db.cliente_oauth.update({ where: { id: cliente.id }, data: { activo: false } });
}

/**
 * Las pruebas no borran (el borrado físico está prohibido): al terminar desactivan sus cuentas
 * y sus clientes, y `./db/reset.sh` los elimina con todo lo demás.
 */
export async function desactivarDatosDePrueba(app: INestApplication): Promise<void> {
  const prisma = app.get(PrismaService);
  await prisma.db.usuario.updateMany({
    where: { correo: { endsWith: `@${DOMINIO_PRUEBAS}` }, activo: true },
    data: { activo: false },
  });
  await prisma.db.cliente_oauth.updateMany({
    where: { codigo: { startsWith: PREFIJO_CLIENTES_PRUEBA }, activo: true },
    data: { activo: false },
  });
}

/** `Authorization: Basic` como lo arma un cliente de OAuth 2.0 (RFC 6749, sección 2.3.1). */
export function basic(clientId: string, secreto: string): string {
  const codificar = (valor: string) => encodeURIComponent(valor).replace(/%20/g, '+');
  return `Basic ${Buffer.from(`${codificar(clientId)}:${codificar(secreto)}`).toString('base64')}`;
}
