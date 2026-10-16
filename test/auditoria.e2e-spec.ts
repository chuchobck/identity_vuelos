import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { auditoria_seguridad } from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { pemDe } from './utils/claves';
import { crearApp } from './utils/crear-app';
import {
  basic,
  CONTRASENA_PRUEBA,
  correoDePrueba,
  crearClienteDePrueba,
  crearUsuario,
  desactivarCliente,
  desactivarDatosDePrueba,
  desactivarUsuario,
} from './utils/cuentas';
import { LimitesReiniciables } from './utils/limites';

const AUTH = '/identity/v1/auth';
const ADMIN = '/identity/v1/admin/users';

interface Esperado {
  /** Lo que se hizo, para el mensaje de la prueba. */
  accion: string;
  requestId: string;
  ip: string;
  evento: string;
  resultado: 'EXITO' | 'FALLO';
  motivo: string | null;
  actor: 'usuario' | 'cliente' | 'ninguno';
  correoParcial?: string;
  /** actor_id: el administrador que hizo el cambio (solo en /admin/users). */
  autor?: string;
}

/**
 * Cada evento de seguridad deja su fila en auditoria_seguridad (con la IP y el X-Request-Id de la
 * petición), y ni esas filas ni los logs (todos, con debug encendido) llevan contraseñas,
 * hashes, tokens, secretos de cliente, la clave privada ni correos completos.
 *
 * Todo el recorrido corre una vez en beforeAll; las pruebas solo revisan lo que dejó.
 */
describe('Auditoría de seguridad y escaneo de datos sensibles', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let idInicial: bigint;
  const logs: string[] = [];
  const limites = new LimitesReiniciables();
  const esperados: Esperado[] = [];
  /** Todo lo que no puede aparecer en un log ni en una fila de auditoría. */
  const sensibles = new Set<string>();
  const http = () => request(app.getHttpServer());

  /** Una petición con su propio X-Request-Id y una IP de documentación (TRUST_PROXY=loopback). */
  const conId = (
    prueba: request.Test,
    accion: string,
    esperado: Omit<Esperado, 'accion' | 'requestId' | 'ip'>,
  ) => {
    const requestId = `aud-${randomUUID()}`;
    const ip = `203.0.113.${esperados.length + 1}`;
    esperados.push({ accion, requestId, ip, ...esperado });
    return prueba.set('X-Request-Id', requestId).set('X-Forwarded-For', ip);
  };

  const guardar = (...valores: Array<string | undefined>) => {
    for (const valor of valores) if (valor) sensibles.add(valor);
  };

  beforeAll(async () => {
    app = await crearApp({ limites, logs });
    prisma = app.get(PrismaService);
    const ultima = await prisma.db.auditoria_seguridad.findFirst({ orderBy: { id: 'desc' } });
    idInicial = ultima?.id ?? 0n;

    // La clave privada: en base64 (la variable) y cada línea del cuerpo del PEM
    const privada = process.env.JWT_SIGNING_KEY ?? '';
    guardar(privada);
    for (const linea of pemDe(privada).split('\n')) {
      if (linea.length > 20 && !linea.startsWith('-----')) guardar(linea);
    }

    // --- personas -----------------------------------------------------------------
    const correo = correoDePrueba();
    const contrasena = `${CONTRASENA_PRUEBA} ${randomUUID()}`;
    guardar(correo, contrasena);
    await conId(
      http().post(`${AUTH}/register`).send({ email: correo, password: contrasena }),
      'registro',
      { evento: 'REGISTRO', resultado: 'EXITO', motivo: null, actor: 'usuario' },
    ).expect(201);
    await conId(
      http().post(`${AUTH}/register`).send({ email: correo, password: contrasena }),
      'registro repetido',
      { evento: 'REGISTRO', resultado: 'FALLO', motivo: 'CORREO_REGISTRADO', actor: 'usuario' },
    ).expect(409);

    const login = await conId(
      http().post(`${AUTH}/login`).send({ email: correo, password: contrasena }),
      'login correcto',
      { evento: 'LOGIN', resultado: 'EXITO', motivo: null, actor: 'usuario' },
    ).expect(200);
    guardar(login.body.access_token, login.body.refresh_token);

    const erronea = `contraseña equivocada ${randomUUID()}`;
    guardar(erronea);
    await conId(
      http().post(`${AUTH}/login`).send({ email: correo, password: erronea }),
      'login con contraseña errónea',
      { evento: 'LOGIN', resultado: 'FALLO', motivo: 'CONTRASENA_INVALIDA', actor: 'usuario' },
    ).expect(401);

    const desconocido = correoDePrueba();
    guardar(desconocido);
    await conId(
      http().post(`${AUTH}/login`).send({ email: desconocido, password: contrasena }),
      'login con correo desconocido',
      {
        evento: 'LOGIN',
        resultado: 'FALLO',
        motivo: 'CORREO_DESCONOCIDO',
        actor: 'ninguno',
        correoParcial: `e2***@${desconocido.split('@')[1]}`,
      },
    ).expect(401);
    limites.reiniciar();

    const refresco = await conId(
      http().post(`${AUTH}/refresh`).send({ refresh_token: login.body.refresh_token }),
      'refresh',
      { evento: 'REFRESCO', resultado: 'EXITO', motivo: null, actor: 'usuario' },
    ).expect(200);
    guardar(refresco.body.access_token, refresco.body.refresh_token);
    await conId(
      http().post(`${AUTH}/refresh`).send({ refresh_token: login.body.refresh_token }),
      'reuso del refresh rotado',
      { evento: 'REUSO_REFRESCO', resultado: 'FALLO', motivo: 'REUTILIZACION', actor: 'usuario' },
    ).expect(401);
    await conId(
      http().post(`${AUTH}/refresh`).send({ refresh_token: refresco.body.refresh_token }),
      'refresh de la familia revocada',
      { evento: 'REFRESCO', resultado: 'FALLO', motivo: 'TOKEN_REVOCADO', actor: 'usuario' },
    ).expect(401);
    const inventado = 'B'.repeat(43);
    await conId(
      http().post(`${AUTH}/refresh`).send({ refresh_token: inventado }),
      'refresh desconocido',
      { evento: 'REFRESCO', resultado: 'FALLO', motivo: 'TOKEN_DESCONOCIDO', actor: 'ninguno' },
    ).expect(401);

    const sesion = await http()
      .post(`${AUTH}/login`)
      .set('X-Forwarded-For', '198.51.100.1')
      .send({ email: correo, password: contrasena })
      .expect(200);
    esperados.push({
      accion: 'login sin X-Request-Id propio',
      requestId: sesion.headers['x-request-id'],
      ip: '198.51.100.1',
      evento: 'LOGIN',
      resultado: 'EXITO',
      motivo: null,
      actor: 'usuario',
    });
    guardar(sesion.body.access_token, sesion.body.refresh_token);
    await conId(
      http()
        .post(`${AUTH}/logout`)
        .set('Authorization', `Bearer ${sesion.body.access_token}`)
        .send({ refresh_token: sesion.body.refresh_token }),
      'logout',
      { evento: 'LOGOUT', resultado: 'EXITO', motivo: null, actor: 'usuario' },
    ).expect(204);

    const inactiva = await crearUsuario(app);
    guardar(inactiva.correo);
    const sesionInactiva = await http()
      .post(`${AUTH}/login`)
      .send({ email: inactiva.correo, password: inactiva.contrasena })
      .expect(200);
    guardar(sesionInactiva.body.access_token, sesionInactiva.body.refresh_token);
    await desactivarUsuario(app, inactiva);
    limites.reiniciar();
    await conId(
      http().post(`${AUTH}/login`).send({ email: inactiva.correo, password: inactiva.contrasena }),
      'login de cuenta inactiva',
      { evento: 'LOGIN', resultado: 'FALLO', motivo: 'CUENTA_INACTIVA', actor: 'usuario' },
    ).expect(401);
    await conId(
      http().get(`${AUTH}/me`).set('Authorization', `Bearer ${sesionInactiva.body.access_token}`),
      'perfil de cuenta inactiva',
      {
        evento: 'ACCESO_CUENTA_INACTIVA',
        resultado: 'FALLO',
        motivo: 'CUENTA_INACTIVA',
        actor: 'usuario',
      },
    ).expect(401);

    // --- clientes OAuth -----------------------------------------------------------
    const cliente = await crearClienteDePrueba(app, { scopes: 'flights:read' });
    const inactivo = await crearClienteDePrueba(app, { scopes: 'flights:read' });
    await desactivarCliente(app, inactivo);
    guardar(cliente.secreto, inactivo.secreto);
    const formulario = (autorizacion: string, extra: Record<string, string> = {}) =>
      http()
        .post('/oauth2/token')
        .set('Authorization', autorizacion)
        .type('form')
        .send({ grant_type: 'client_credentials', ...extra });

    const emitido = await conId(
      formulario(basic(cliente.clientId, cliente.secreto)),
      'token de cliente',
      {
        evento: 'TOKEN_CLIENTE',
        resultado: 'EXITO',
        motivo: null,
        actor: 'cliente',
      },
    ).expect(200);
    guardar(emitido.body.access_token);
    const secretoErrado = `secreto-errado-${randomUUID()}`;
    guardar(secretoErrado);
    await conId(formulario(basic(cliente.clientId, secretoErrado)), 'secreto errado', {
      evento: 'TOKEN_CLIENTE',
      resultado: 'FALLO',
      motivo: 'SECRETO_INVALIDO',
      actor: 'cliente',
    }).expect(401);
    await conId(formulario(basic('e2e-desconocido', cliente.secreto)), 'cliente desconocido', {
      evento: 'TOKEN_CLIENTE',
      resultado: 'FALLO',
      motivo: 'CLIENTE_DESCONOCIDO',
      actor: 'ninguno',
    }).expect(401);
    await conId(formulario(basic(inactivo.clientId, inactivo.secreto)), 'cliente inactivo', {
      evento: 'TOKEN_CLIENTE',
      resultado: 'FALLO',
      motivo: 'CLIENTE_INACTIVO',
      actor: 'cliente',
    }).expect(401);
    await conId(
      formulario(basic(cliente.clientId, cliente.secreto), { scope: 'flights:admin' }),
      'scope no permitido',
      {
        evento: 'TOKEN_CLIENTE',
        resultado: 'FALLO',
        motivo: 'SCOPE_NO_PERMITIDO',
        actor: 'cliente',
      },
    ).expect(400);
    await conId(
      http()
        .post('/oauth2/token')
        .set('Authorization', basic(cliente.clientId, cliente.secreto))
        .type('form')
        .send({ grant_type: 'password', username: correo, password: contrasena }),
      'grant ajeno',
      {
        evento: 'TOKEN_CLIENTE',
        resultado: 'FALLO',
        motivo: 'GRANT_NO_SOPORTADO',
        actor: 'ninguno',
      },
    ).expect(400);

    // --- administración (/admin/users) ------------------------------------------------
    const admin = await crearUsuario(app, { administrador: true });
    guardar(admin.correo);
    limites.reiniciar();
    const sesionAdmin = await http()
      .post(`${AUTH}/login`)
      .send({ email: admin.correo, password: admin.contrasena })
      .expect(200);
    guardar(sesionAdmin.body.access_token, sesionAdmin.body.refresh_token);
    const comoAdmin = (prueba: request.Test) =>
      prueba.set('Authorization', `Bearer ${sesionAdmin.body.access_token}`);
    const correoNuevo = correoDePrueba();
    const contrasenaNueva = `${CONTRASENA_PRUEBA} admin ${randomUUID()}`;
    const contrasenaCorta = randomUUID().slice(0, 11);
    guardar(correoNuevo, contrasenaNueva, contrasenaCorta);

    const creado = await conId(
      comoAdmin(http().post(ADMIN).send({ email: correoNuevo, password: contrasenaNueva })),
      'alta de administrador',
      {
        evento: 'ADMINISTRADOR_CREADO',
        resultado: 'EXITO',
        motivo: null,
        actor: 'usuario',
        autor: admin.id,
      },
    ).expect(201);
    await conId(
      comoAdmin(
        http().post(ADMIN).send({ email: correoNuevo.toUpperCase(), password: contrasenaNueva }),
      ),
      'alta de administrador repetida',
      {
        evento: 'ADMINISTRADOR_CREADO',
        resultado: 'FALLO',
        motivo: 'CORREO_REGISTRADO',
        actor: 'usuario',
        autor: admin.id,
      },
    ).expect(409);
    // Una contraseña rechazada por corta: el 400 nombra el campo, nunca el valor
    await comoAdmin(
      http().post(ADMIN).send({ email: correoDePrueba(), password: contrasenaCorta }),
    ).expect(400);
    await conId(comoAdmin(http().delete(`${ADMIN}/${admin.id}`)), 'baja de la propia cuenta', {
      evento: 'ADMINISTRADOR_DADO_DE_BAJA',
      resultado: 'FALLO',
      motivo: 'PROPIA_CUENTA',
      actor: 'usuario',
      autor: admin.id,
    }).expect(409);
    await conId(comoAdmin(http().delete(`${ADMIN}/${creado.body.id}`)), 'baja de administrador', {
      evento: 'ADMINISTRADOR_DADO_DE_BAJA',
      resultado: 'EXITO',
      motivo: null,
      actor: 'usuario',
      autor: admin.id,
    }).expect(204);

    // Los hashes guardados tampoco pueden salir a ningún lado
    const usuarios = await prisma.db.usuario.findMany({
      where: { correo: { in: [correo, inactiva.correo, admin.correo, correoNuevo] } },
    });
    const clientes = await prisma.db.cliente_oauth.findMany({
      where: { id: { in: [cliente.id, inactivo.id] } },
    });
    guardar(...usuarios.map((u) => u.hash_contrasena), ...clientes.map((c) => c.hash_secreto));
  });

  afterAll(async () => {
    await desactivarDatosDePrueba(app);
    await app.close();
  });

  const filasNuevas = (): Promise<auditoria_seguridad[]> =>
    prisma.db.auditoria_seguridad.findMany({
      where: { id: { gt: idInicial } },
      orderBy: { id: 'asc' },
    });

  it('cada evento deja su fila, con la IP y el X-Request-Id de la petición', async () => {
    const filas = await filasNuevas();
    for (const esperado of esperados) {
      const fila = filas.find((f) => f.id_peticion === esperado.requestId);
      expect({ accion: esperado.accion, encontrada: fila !== undefined }).toEqual({
        accion: esperado.accion,
        encontrada: true,
      });
      if (!fila) continue;
      expect({
        accion: esperado.accion,
        evento: fila.evento,
        resultado: fila.resultado,
        motivo: fila.motivo,
        ip: fila.direccion_ip,
        actor: fila.usuario_id ? 'usuario' : fila.cliente_id ? 'cliente' : 'ninguno',
        correoParcial: fila.correo_parcial ?? undefined,
        autor: fila.actor_id ?? undefined,
      }).toEqual({
        accion: esperado.accion,
        evento: esperado.evento,
        resultado: esperado.resultado,
        motivo: esperado.motivo,
        ip: esperado.ip,
        actor: esperado.actor,
        correoParcial: esperado.correoParcial,
        autor: esperado.autor,
      });
    }
  });

  it('el alta de un cliente también queda registrada (CLIENTE_CREADO)', async () => {
    const creados = (await filasNuevas()).filter((f) => f.evento === 'CLIENTE_CREADO');
    expect(creados).toHaveLength(2);
    for (const fila of creados) expect(fila.cliente_id).not.toBeNull();
  });

  it('ninguna fila de auditoría ni línea de log lleva contraseñas, hashes, tokens, secretos, claves ni correos', async () => {
    const filas = JSON.stringify(await filasNuevas(), (_clave, valor: unknown) =>
      typeof valor === 'bigint' ? valor.toString() : valor,
    );
    const textoLogs = logs.join('\n');

    // El escaneo vio de verdad el recorrido: hay logs de acceso y de errores con request id
    expect(logs.length).toBeGreaterThan(40);
    expect(textoLogs).toContain('POST /identity/v1/auth/login 200');
    expect(textoLogs).toContain('POST /oauth2/token 401');
    expect(textoLogs).toContain('POST /identity/v1/admin/users 201');
    expect(textoLogs).toContain('POST /identity/v1/admin/users 400');
    expect(sensibles.size).toBeGreaterThan(25);

    const filtrados = [...sensibles].filter((v) => filas.includes(v) || textoLogs.includes(v));
    expect(filtrados.map((v) => `${v.slice(0, 12)}… (${v.length} caracteres)`)).toEqual([]);

    // Y por forma, aunque el valor no esté en la lista: un JWT, un hash, un PEM, un Bearer o Basic
    for (const patron of [
      /eyJ[\w-]{10,}\.[\w-]{10,}\./,
      /\$argon2id\$/,
      /-----BEGIN/,
      /LS0tLS1CRUdJTi/,
      /Bearer [\w-]{20,}/,
      /Basic [A-Za-z0-9+/=]{12,}/,
    ]) {
      expect({ patron: String(patron), enFilas: patron.test(filas) }).toEqual({
        patron: String(patron),
        enFilas: false,
      });
      expect({ patron: String(patron), enLogs: patron.test(textoLogs) }).toEqual({
        patron: String(patron),
        enLogs: false,
      });
    }
  });
});
