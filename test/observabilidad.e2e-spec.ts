import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import * as request from 'supertest';
import { ATRIBUTOS_PERMITIDOS, TIPOS_DE_ERROR } from '../src/observabilidad/atributos';
import { CUBETAS_DURACION } from '../src/observabilidad/metricas';
import {
  basic,
  CONTRASENA_PRUEBA,
  correoDePrueba,
  crearClienteDePrueba,
  crearUsuario,
  desactivarDatosDePrueba,
  desactivarUsuario,
} from './utils/cuentas';
import { LimitesReiniciables } from './utils/limites';
import { RecolectorOtlp } from './utils/recolector-otlp';

const AUTH = '/identity/v1/auth';
const TRAZA_CLIENTE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PADRE_CLIENTE = '00f067aa0ba902b7';
/** OTLP SpanKind del cable: 1 INTERNAL, 2 SERVER. */
const INTERNAL = 1;
const SERVER = 2;

async function puertoLibre(): Promise<number> {
  const servidor = createServer();
  await new Promise<void>((listo) => servidor.listen(0, '127.0.0.1', listo));
  const { port } = servidor.address() as AddressInfo;
  await new Promise<void>((listo) => servidor.close(() => listo()));
  return port;
}

/** Las series de una métrica como { etiquetas: valor }. */
function series(texto: string, nombre: string): Map<string, number> {
  const mapa = new Map<string, number>();
  for (const linea of texto.split('\n')) {
    if (!linea.startsWith(`${nombre}{`) && !linea.startsWith(`${nombre} `)) continue;
    const espacio = linea.lastIndexOf(' ');
    mapa.set(linea.slice(nombre.length, espacio), Number(linea.slice(espacio + 1)));
  }
  return mapa;
}

/**
 * El estándar de observabilidad de Quinde (docs/OBSERVABILIDAD.md): trazas con un recolector OTLP
 * falso (se mira el JSON que de verdad sale), métricas en su puerto, logs con traceId y un
 * escaneo de datos sensibles sobre todo lo que se emite.
 */
describe('Observabilidad (trazas, métricas y logs)', () => {
  let app: NestExpressApplication;
  let urlMetricas: string;
  const recolector = new RecolectorOtlp();
  const logs: string[] = [];
  const limites = new LimitesReiniciables();
  const sensibles = new Set<string>();
  const http = () => request(app.getHttpServer());
  const metricas = async () => (await fetch(`${urlMetricas}/metrics`)).text();

  beforeAll(async () => {
    await recolector.iniciar();
    const puerto = await puertoLibre();
    process.env.METRICS_PORT = String(puerto);
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = recolector.url;
    process.env.OTEL_BSP_SCHEDULE_DELAY = '20';
    // AppModule valida el entorno al importarse: se carga ya con METRICS_PORT y el recolector fijados
    const { crearApp } = await import('./utils/crear-app');
    app = await crearApp({ limites, logs });
    urlMetricas = `http://127.0.0.1:${puerto}`;
  });

  beforeEach(() => limites.reiniciar());

  afterAll(async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_BSP_SCHEDULE_DELAY;
    process.env.METRICS_PORT = '0';
    await desactivarDatosDePrueba(app);
    await app.close();
    await recolector.detener();
  });

  describe('trazas', () => {
    it('continúa el traceparent del gateway (servicio interno): X-Trace-Id es esa traza', async () => {
      const respuesta = await http()
        .get('/identity/v1/health')
        .set('traceparent', `00-${TRAZA_CLIENTE}-${PADRE_CLIENTE}-01`)
        .expect(200);
      expect(respuesta.headers['x-trace-id']).toBe(TRAZA_CLIENTE);
      const [span] = await recolector.esperarTraza(TRAZA_CLIENTE, 1);
      expect(span).toMatchObject({
        servicio: 'quinde-identity',
        tipo: SERVER,
        parentSpanId: PADRE_CLIENTE,
        nombre: 'GET /identity/v1/health',
      });
      expect(span.recurso['deployment.environment']).toBe('test');
      expect(span.recurso['service.version']).toBe('0.2.0');
    });

    it.each([
      ['de versión ff', `ff-${TRAZA_CLIENTE}-${PADRE_CLIENTE}-01`],
      ['en mayúsculas', `00-${TRAZA_CLIENTE.toUpperCase()}-${PADRE_CLIENTE}-01`],
      ['con campos extra', `00-${TRAZA_CLIENTE}-${PADRE_CLIENTE}-01-extra`],
      ['con ids en ceros', `00-${'0'.repeat(32)}-${PADRE_CLIENTE}-01`],
    ])(
      'un traceparent %s se descarta: abre una traza nueva y la petición sigue',
      async (_c, valor) => {
        const respuesta = await http()
          .get('/identity/v1/health')
          .set('traceparent', valor)
          .expect(200);
        expect(respuesta.headers['x-trace-id']).toMatch(/^[0-9a-f]{32}$/);
        expect(respuesta.headers['x-trace-id']).not.toBe(TRAZA_CLIENTE);
      },
    );

    it('sin traceparent, abre una traza y la devuelve en X-Trace-Id', async () => {
      const respuesta = await http().get('/identity/v1/health').expect(200);
      const id = respuesta.headers['x-trace-id'];
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      const spans = await recolector.esperarTraza(id, 1);
      expect(spans[0].parentSpanId).toBe('');
    });

    it('el nombre y http.route son la PLANTILLA, nunca la ruta pedida; lo desconocido es __unmatched__', async () => {
      const id = randomUUID();
      const baja = await http().delete(`/identity/v1/admin/users/${id}`);
      const inventada = await http().get(`/identity/v1/inventada/${randomUUID()}?x=1`).expect(404);
      const a = await recolector.esperarTraza(baja.headers['x-trace-id'], 1);
      const b = await recolector.esperarTraza(inventada.headers['x-trace-id'], 1);
      expect(a[0].nombre).toBe('DELETE /identity/v1/admin/users/{id}');
      expect(a[0].atributos['http.route']).toBe('/identity/v1/admin/users/{id}');
      expect(b[0].nombre).toBe('GET __unmatched__');
      expect(b[0].atributos['http.route']).toBe('__unmatched__');
      // Un 4xx no es error del servidor
      expect(b[0].estado.code ?? 0).not.toBe(2);
      expect(JSON.stringify(recolector.spans)).not.toContain(id);
    });

    it('login, refresh y token abren un span INTERNAL hijo del SERVER, sin marcar error un 401', async () => {
      const usuario = await crearUsuario(app);
      const login = await http()
        .post(`${AUTH}/login`)
        .send({ email: usuario.correo, password: CONTRASENA_PRUEBA })
        .expect(200);
      const fallido = await http()
        .post(`${AUTH}/login`)
        .send({ email: usuario.correo, password: 'una contraseña equivocada' })
        .expect(401);
      const refresco = await http()
        .post(`${AUTH}/refresh`)
        .send({ refresh_token: login.body.refresh_token })
        .expect(200);
      const cliente = await crearClienteDePrueba(app, { scopes: 'flights:read' });
      const token = await http()
        .post('/oauth2/token')
        .set('Authorization', basic(cliente.clientId, cliente.secreto))
        .type('form')
        .send({ grant_type: 'client_credentials' })
        .expect(200);

      const esperados: Array<[request.Response, string, string]> = [
        [login, 'auth.login', 'POST /identity/v1/auth/login'],
        [fallido, 'auth.login', 'POST /identity/v1/auth/login'],
        [refresco, 'auth.refresh', 'POST /identity/v1/auth/refresh'],
        [token, 'oauth2.token', 'POST /oauth2/token'],
      ];
      for (const [respuesta, interno, servidor] of esperados) {
        const spans = await recolector.esperarTraza(respuesta.headers['x-trace-id'], 2);
        const raiz = spans.find((s) => s.tipo === SERVER)!;
        const hijo = spans.find((s) => s.tipo === INTERNAL)!;
        expect(raiz.nombre).toBe(servidor);
        expect(hijo.nombre).toBe(interno);
        expect(hijo.parentSpanId).toBe(raiz.spanId);
        expect(hijo.estado.code ?? 0).not.toBe(2);
        expect(raiz.estado.code ?? 0).not.toBe(2);
      }
    });

    it('solo atributos permitidos y error.type de la lista cerrada; nada sensible en lo que sale', async () => {
      const usuario = await crearUsuario(app);
      const contrasena = `${CONTRASENA_PRUEBA} ${randomUUID()}`;
      const secreto = `secreto-${randomUUID()}`;
      for (const valor of [usuario.correo, contrasena, secreto, usuario.id]) sensibles.add(valor);
      const login = await http()
        .post(`${AUTH}/login?token=${secreto}`)
        .set('X-Forwarded-For', '203.0.113.77')
        .send({ email: usuario.correo, password: contrasena });
      sensibles.add('203.0.113.77');
      const sesion = await http()
        .post(`${AUTH}/login`)
        .send({ email: usuario.correo, password: CONTRASENA_PRUEBA })
        .expect(200);
      sensibles.add(sesion.body.access_token);
      sensibles.add(sesion.body.refresh_token);
      await http()
        .get(`${AUTH}/me`)
        .set('Authorization', `Bearer ${sesion.body.access_token}`)
        .expect(200);
      await desactivarUsuario(app, usuario);
      await recolector.esperarTraza(login.headers['x-trace-id'], 2);
      await new Promise((listo) => setTimeout(listo, 200));

      expect(recolector.spans.length).toBeGreaterThan(5);
      for (const span of recolector.spans) {
        for (const nombre of Object.keys(span.atributos)) {
          expect(ATRIBUTOS_PERMITIDOS.has(nombre)).toBe(true);
        }
        const tipo = span.atributos['error.type'];
        if (tipo !== undefined) expect(TIPOS_DE_ERROR.has(String(tipo))).toBe(true);
        expect(span.estado.message).toBeUndefined();
      }
      const crudo = recolector.cuerpos.join('\n');
      for (const valor of sensibles) expect(crudo.includes(valor)).toBe(false);
      expect(crudo).not.toMatch(/Bearer |authorization|password|argon2id|@e2e\.quinde/i);
    });

    it('un recolector caído nunca rompe ni retrasa una petición', async () => {
      recolector.demoraMs = 10_000;
      const inicio = Date.now();
      await http().get('/identity/v1/health').expect(200);
      expect(Date.now() - inicio).toBeLessThan(2000);
      recolector.demoraMs = 0;
    });
  });

  describe('métricas', () => {
    it('GET /metrics solo en su puerto: lo comunes, build_info y las cubetas del estándar', async () => {
      await http().get('/identity/v1/health').expect(200);
      const texto = await metricas();
      const salud = '{method="GET",route="/identity/v1/health",status="200"}';
      expect(series(texto, 'http_server_requests_total').get(salud)).toBeGreaterThanOrEqual(1);
      expect(
        series(texto, 'http_server_request_duration_seconds_count').get(salud),
      ).toBeGreaterThanOrEqual(1);
      expect(texto).toContain('# TYPE http_client_request_duration_seconds histogram');
      expect(texto).toMatch(
        /quinde_build_info\{service="quinde-identity",version="0\.2\.0",environment="test"\} 1/,
      );
      expect(texto).toContain('process_cpu_user_seconds_total');
      expect(texto).toContain('nodejs_eventloop_lag_seconds');
      const cubetas = [...series(texto, 'http_server_request_duration_seconds_bucket').keys()]
        .filter((k) => k.includes('route="/identity/v1/health"'))
        .map((k) => /le="([^"]+)"/.exec(k)?.[1]);
      expect(cubetas).toEqual([...CUBETAS_DURACION.map(String), '+Inf']);

      // Solo GET /metrics: lo demás es 404; y en el puerto público /metrics no existe
      expect((await fetch(`${urlMetricas}/otra`)).status).toBe(404);
      expect((await fetch(`${urlMetricas}/metrics`, { method: 'POST' })).status).toBe(404);
      await http().get('/metrics').expect(404);
    });

    it('cardinalidad acotada: mil rutas inventadas son UNA serie por status (__unmatched__), sin ids', async () => {
      for (let i = 0; i < 25; i++) await http().get(`/identity/v1/x/${randomUUID()}`).expect(404);
      // La ruta existe con DELETE: con GET es un 405 que ninguna plantilla atendió
      for (let i = 0; i < 3; i++) {
        await http().get(`/identity/v1/admin/users/${randomUUID()}`).expect(405);
      }
      // Y con DELETE sin token se atiende por su plantilla (el 401 lo da el guard)
      await http().delete(`/identity/v1/admin/users/${randomUUID()}`).expect(401);
      const texto = await metricas();
      const peticiones = series(texto, 'http_server_requests_total');
      const sinPlantilla = [...peticiones.keys()].filter((k) => k.includes('__unmatched__')).sort();
      expect(sinPlantilla).toEqual([
        '{method="GET",route="__unmatched__",status="404"}',
        '{method="GET",route="__unmatched__",status="405"}',
      ]);
      expect(peticiones.get(sinPlantilla[0])).toBeGreaterThanOrEqual(25);
      expect(
        peticiones.get('{method="DELETE",route="/identity/v1/admin/users/{id}",status="401"}'),
      ).toBeGreaterThanOrEqual(1);
      expect([...peticiones.keys()].some((k) => /[0-9a-f]{8}-[0-9a-f]{4}/.test(k))).toBe(false);
      expect(texto).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    });

    it('propias acotadas: logins por resultado y tokens emitidos por tipo', async () => {
      const antes = await metricas();
      const logins = (t: string, r: string) =>
        series(t, 'identity_logins_total').get(`{result="${r}"}`)!;
      const tokens = (t: string, tipo: string) =>
        series(t, 'identity_tokens_issued_total').get(`{type="${tipo}"}`)!;

      const activo = await crearUsuario(app);
      const inactivo = await crearUsuario(app);
      await desactivarUsuario(app, inactivo);
      const login = await http()
        .post(`${AUTH}/login`)
        .send({ email: activo.correo, password: CONTRASENA_PRUEBA })
        .expect(200);
      await http()
        .post(`${AUTH}/login`)
        .send({ email: activo.correo, password: 'incorrecta 123456' })
        .expect(401);
      await http()
        .post(`${AUTH}/login`)
        .send({ email: correoDePrueba(), password: CONTRASENA_PRUEBA })
        .expect(401);
      await http()
        .post(`${AUTH}/login`)
        .send({ email: inactivo.correo, password: CONTRASENA_PRUEBA })
        .expect(401);
      await http()
        .post(`${AUTH}/refresh`)
        .send({ refresh_token: login.body.refresh_token })
        .expect(200);
      const cliente = await crearClienteDePrueba(app, { scopes: 'flights:read' });
      await http()
        .post('/oauth2/token')
        .set('Authorization', basic(cliente.clientId, cliente.secreto))
        .type('form')
        .send({ grant_type: 'client_credentials' })
        .expect(200);

      const despues = await metricas();
      expect(logins(despues, 'success') - logins(antes, 'success')).toBe(1);
      expect(logins(despues, 'invalid_credentials') - logins(antes, 'invalid_credentials')).toBe(2);
      expect(logins(despues, 'inactive_account') - logins(antes, 'inactive_account')).toBe(1);
      expect(tokens(despues, 'user_login') - tokens(antes, 'user_login')).toBe(1);
      expect(tokens(despues, 'user_refresh') - tokens(antes, 'user_refresh')).toBe(1);
      expect(tokens(despues, 'client_credentials') - tokens(antes, 'client_credentials')).toBe(1);
      // Solo esas series: ni correos, ni ids, ni client_id como etiqueta
      expect([...series(despues, 'identity_logins_total').keys()].sort()).toEqual([
        '{result="inactive_account"}',
        '{result="invalid_credentials"}',
        '{result="success"}',
      ]);
      expect(despues).not.toContain(activo.correo);
      expect(despues).not.toContain(cliente.clientId);
      expect(despues).not.toMatch(/Bearer |argon2id|@e2e\.quinde/i);
    });
  });

  describe('logs', () => {
    it('toda línea escrita durante una petición lleva requestId, correlationId, traceId y spanId', async () => {
      const peticion = `req-log-${randomUUID().slice(0, 8)}`;
      const respuesta = await http().get(`${AUTH}/me`).set('X-Request-Id', peticion).expect(401);
      const traza = respuesta.headers['x-trace-id'];
      const lineas = logs.map((l) => JSON.parse(l)).filter((l) => l.requestId === peticion);
      // La de acceso y la del error de la misma petición
      expect(lineas.length).toBeGreaterThanOrEqual(2);
      for (const linea of lineas) {
        expect(linea.traceId).toBe(traza);
        expect(linea.spanId).toMatch(/^[0-9a-f]{16}$/);
        expect(linea.correlationId).toMatch(/^[A-Za-z0-9]/);
      }
      const acceso = lineas.find((l) =>
        String(l.message).startsWith('GET /identity/v1/auth/me 401'),
      );
      expect(acceso).toBeDefined();
    });

    it('también el error del parser del cuerpo (fuera del contexto del span) lleva traceId', async () => {
      const respuesta = await http()
        .post(`${AUTH}/login`)
        .set('Content-Type', 'application/json')
        .send('{"roto":');
      expect(respuesta.status).toBe(400);
      const traza = respuesta.headers['x-trace-id'];
      const lineas = logs.map((l) => JSON.parse(l)).filter((l) => l.traceId === traza);
      expect(lineas.length).toBeGreaterThanOrEqual(1);
    });
  });
});
