import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { crearApp } from './utils/crear-app';
import {
  basic,
  CONTRASENA_PRUEBA,
  crearClienteDePrueba,
  crearUsuario,
  desactivarDatosDePrueba,
} from './utils/cuentas';
import { LimitesReiniciables } from './utils/limites';
import { esperarErrorOAuth, esperarProblemDetails } from './utils/problem-details';

const AUTH = '/identity/v1/auth';
const CABECERA = 'x-correlation-id';

/**
 * X-Correlation-Id del contrato v2 (§6): se lee, se genera si falta, se devuelve en toda
 * respuesta, va en `ProblemDetails.correlation_id`, en cada línea de log y en la auditoría de
 * seguridad. Es independiente de X-Request-Id (un id por salto).
 */
describe('X-Correlation-Id', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const logs: string[] = [];
  const limites = new LimitesReiniciables();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await crearApp({ limites, logs });
    prisma = app.get(PrismaService);
  });

  beforeEach(() => limites.reiniciar());

  afterAll(async () => {
    await desactivarDatosDePrueba(app);
    await app.close();
  });

  const lineasCon = (valor: string) =>
    logs.filter((linea) => linea.includes(valor)).map((linea) => JSON.parse(linea));

  it('el que manda el cliente se devuelve igual, sin cambios', async () => {
    const id = `corr-vuelos-${randomUUID().slice(0, 8)}`;
    const respuesta = await http()
      .get('/identity/v1/health')
      .set('X-Correlation-Id', id)
      .expect(200);
    expect(respuesta.headers[CABECERA]).toBe(id);
  });

  it('si falta, el servicio lo genera, y cada petición recibe uno distinto', async () => {
    const a = await http().get('/identity/v1/health').expect(200);
    const b = await http().get('/identity/v1/health').expect(200);
    expect(a.headers[CABECERA]).toMatch(/^corr-[0-9a-f-]{36}$/);
    expect(b.headers[CABECERA]).not.toBe(a.headers[CABECERA]);
  });

  it.each([
    ['con espacios', 'corr con espacios'],
    ['con comillas (inyección en un log JSON)', 'corr-1","level":"fatal'],
    ['de más de 100 caracteres', 'a'.repeat(101)],
    ['con un carácter raro', 'corr-<script>'],
    ['que empieza con un guion', '-corr-1'],
  ])('uno %s se descarta y se genera otro (la petición no se rechaza)', async (_caso, valor) => {
    const respuesta = await http()
      .get('/identity/v1/health')
      .set('X-Correlation-Id', valor)
      .expect(200);
    expect(respuesta.headers[CABECERA]).toMatch(/^corr-[0-9a-f-]{36}$/);
  });

  it('el de 100 caracteres justos sí vale', async () => {
    const id = `c${'a'.repeat(99)}`;
    const respuesta = await http()
      .get('/identity/v1/health')
      .set('X-Correlation-Id', id)
      .expect(200);
    expect(respuesta.headers[CABECERA]).toBe(id);
  });

  it('es independiente del X-Request-Id: cada uno conserva el suyo', async () => {
    const correlacion = `corr-${randomUUID()}`;
    const peticion = `req-${randomUUID()}`;
    const respuesta = await http()
      .get('/identity/v1/health')
      .set('X-Correlation-Id', correlacion)
      .set('X-Request-Id', peticion)
      .expect(200);
    expect(respuesta.headers[CABECERA]).toBe(correlacion);
    expect(respuesta.headers['x-request-id']).toBe(peticion);
  });

  it('todo error de /identity/v1 lleva correlation_id en el cuerpo, igual al de la cabecera', async () => {
    const id = `corr-error-${randomUUID().slice(0, 8)}`;
    const sinToken = await http().get(`${AUTH}/me`).set('X-Correlation-Id', id).expect(401);
    esperarProblemDetails(sinToken);
    expect(sinToken.body.correlation_id).toBe(id);

    const invalido = await http()
      .post(`${AUTH}/login`)
      .set('X-Correlation-Id', id)
      .send({})
      .expect(400);
    esperarProblemDetails(invalido);

    const ruta = await http().get('/identity/v1/no-existe').expect(404);
    esperarProblemDetails(ruta);
    expect(ruta.body.correlation_id).toMatch(/^corr-/);
  });

  it('/oauth2/token lo devuelve en la cabecera y su error conserva el formato de RFC 6749', async () => {
    const id = `corr-oauth-${randomUUID().slice(0, 8)}`;
    const respuesta = await http()
      .post('/oauth2/token')
      .set('X-Correlation-Id', id)
      .set('Authorization', basic('e2e-desconocido', 'secreto'))
      .type('form')
      .send({ grant_type: 'client_credentials' });
    esperarErrorOAuth(respuesta, 401, 'invalid_client');
    expect(respuesta.headers[CABECERA]).toBe(id);
    expect(respuesta.body.correlation_id).toBeUndefined();
  });

  it('va en la auditoría de seguridad, junto al X-Request-Id', async () => {
    const usuario = await crearUsuario(app);
    const id = `corr-aud-${randomUUID().slice(0, 8)}`;
    const peticion = `req-aud-${randomUUID().slice(0, 8)}`;
    await http()
      .post(`${AUTH}/login`)
      .set('X-Correlation-Id', id)
      .set('X-Request-Id', peticion)
      .send({ email: usuario.correo, password: CONTRASENA_PRUEBA })
      .expect(200);
    await http()
      .post(`${AUTH}/login`)
      .set('X-Correlation-Id', id)
      .send({ email: usuario.correo, password: 'una contraseña equivocada' })
      .expect(401);
    const cliente = await crearClienteDePrueba(app, { scopes: 'flights:read' });
    await http()
      .post('/oauth2/token')
      .set('X-Correlation-Id', id)
      .set('Authorization', basic(cliente.clientId, cliente.secreto))
      .type('form')
      .send({ grant_type: 'client_credentials' })
      .expect(200);

    const filas = await prisma.db.auditoria_seguridad.findMany({
      where: { id_correlacion: id },
      orderBy: { id: 'asc' },
    });
    expect(filas.map((f) => [f.evento, f.resultado])).toEqual([
      ['LOGIN', 'EXITO'],
      ['LOGIN', 'FALLO'],
      ['TOKEN_CLIENTE', 'EXITO'],
    ]);
    expect(filas[0].id_peticion).toBe(peticion);
  });

  it('va en cada línea de log de la petición (acceso y errores), y solo el id, no la cabecera', async () => {
    const id = `corr-log-${randomUUID().slice(0, 8)}`;
    await http().get(`${AUTH}/me`).set('X-Correlation-Id', id).expect(401);
    const lineas = lineasCon(id);
    // La de acceso y la de error de la misma petición
    expect(lineas.length).toBeGreaterThanOrEqual(2);
    for (const linea of lineas) expect(linea.correlationId).toBe(id);
    expect(lineas.some((l) => String(l.message).startsWith('GET /identity/v1/auth/me 401'))).toBe(
      true,
    );
    // Un valor inválido no llega al log tal cual
    const falso = 'corr-1","level":"fatal","x":"falso';
    await http().get('/identity/v1/health').set('X-Correlation-Id', falso).expect(200);
    expect(logs.some((linea) => linea.includes('falso'))).toBe(false);
    // Toda línea escrita durante una petición lleva su correlation id
    const accesos = logs.map((l) => JSON.parse(l)).filter((l) => l.context === 'HTTP');
    expect(accesos.length).toBeGreaterThan(0);
    for (const acceso of accesos) expect(acceso.correlationId).toMatch(/^[A-Za-z0-9]/);
  });

  it('el preflight de CORS lo permite y lo expone', async () => {
    const respuesta = await http()
      .options(`${AUTH}/login`)
      .set('Origin', 'https://app.e2e.quinde.example')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-correlation-id,content-type')
      .expect(204);
    expect(respuesta.headers['access-control-allow-headers']).toContain('X-Correlation-Id');
    const normal = await http()
      .get('/identity/v1/health')
      .set('Origin', 'https://app.e2e.quinde.example');
    expect(normal.headers['access-control-expose-headers']).toContain('X-Correlation-Id');
  });
});
