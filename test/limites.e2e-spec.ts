import { NestExpressApplication } from '@nestjs/platform-express';
import * as request from 'supertest';
import { ClienteCreado } from '../src/modules/oauth2/clientes/alta-cliente';
import { crearApp } from './utils/crear-app';
import {
  basic,
  crearClienteDePrueba,
  crearUsuario,
  desactivarDatosDePrueba,
  UsuarioDePrueba,
} from './utils/cuentas';
import { LimitesReiniciables } from './utils/limites';
import { esperarErrorOAuth, esperarProblemDetails } from './utils/problem-details';
import { RelojDePrueba } from './utils/reloj';

/**
 * Límites de peticiones con el Reloj de la app (un RelojDePrueba que solo avanza cuando la
 * prueba lo pide): ninguna prueba espera de verdad. TRUST_PROXY=loopback deja simular IP
 * distintas con X-Forwarded-For.
 */
describe('Límites de peticiones', () => {
  let app: NestExpressApplication;
  let usuario: UsuarioDePrueba;
  let cliente: ClienteCreado;
  const reloj = new RelojDePrueba();
  const limites = new LimitesReiniciables();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await crearApp({ reloj, limites });
    usuario = await crearUsuario(app);
    cliente = await crearClienteDePrueba(app, { scopes: 'flights:read' });
  });

  beforeEach(() => {
    reloj.alPresente();
    limites.reiniciar();
  });

  afterAll(async () => {
    await desactivarDatosDePrueba(app);
    await app.close();
  });

  const login = (ip = '203.0.113.10') =>
    http()
      .post('/identity/v1/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email: usuario.correo, password: usuario.contrasena });

  const token = (ip: string, secreto = cliente.secreto) =>
    http()
      .post('/oauth2/token')
      .set('X-Forwarded-For', ip)
      .set('Authorization', basic(cliente.clientId, secreto))
      .type('form')
      .send({ grant_type: 'client_credentials' });

  describe('POST /auth/login: 5 por minuto e IP', () => {
    it('el sexto intento del minuto responde 429 aunque la contraseña sea correcta', async () => {
      for (let i = 0; i < 5; i++) await login().expect(200);

      const sexto = await login();
      expect(sexto.status).toBe(429);
      esperarProblemDetails(sexto);
      expect(sexto.body.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(Number(sexto.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(Number(sexto.headers['retry-after'])).toBeLessThanOrEqual(60);
    });

    it('otra IP no comparte el contador, y pasado el minuto se vuelve a poder', async () => {
      for (let i = 0; i < 5; i++) await login().expect(200);
      await login().expect(429);
      await login('203.0.113.99').expect(200);

      reloj.adelantar(1);
      await login().expect(200);
    });
  });

  describe('POST /oauth2/token', () => {
    it('por IP: 20 por minuto; el siguiente responde 429 con el formato de RFC 6749', async () => {
      // Cliente desconocido: no gasta el cupo del cliente real (ese es otro contador)
      const pedir = () =>
        http()
          .post('/oauth2/token')
          .set('X-Forwarded-For', '203.0.113.20')
          .set('Authorization', basic('e2e-otro', 'x'))
          .type('form')
          .send({ grant_type: 'client_credentials' });
      for (let i = 0; i < 10; i++) await pedir().expect(401);
      // Otros 10 con client_id distintos (el límite por cliente es 10)
      for (let i = 0; i < 10; i++) {
        await http()
          .post('/oauth2/token')
          .set('X-Forwarded-For', '203.0.113.20')
          .set('Authorization', basic(`e2e-otro-${i}`, 'x'))
          .type('form')
          .send({ grant_type: 'client_credentials' })
          .expect(401);
      }
      const respuesta = await token('203.0.113.20');
      esperarErrorOAuth(respuesta, 429, 'temporarily_unavailable');
      expect(Number(respuesta.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    });

    it('por cliente: 10 por minuto aunque lleguen de IP distintas', async () => {
      for (let i = 0; i < 10; i++) await token(`198.51.100.${i + 1}`, 'secreto-errado').expect(401);

      // El undécimo intento contra el mismo client_id, desde otra IP y con el secreto correcto
      const respuesta = await token('198.51.100.200');
      esperarErrorOAuth(respuesta, 429, 'temporarily_unavailable');
      expect(respuesta.body.error_description).toMatch(/^Too many token requests/);
      expect(Number(respuesta.headers['retry-after'])).toBeGreaterThanOrEqual(1);

      reloj.adelantar(1);
      await token('198.51.100.200').expect(200);
    });
  });

  describe('chequeos de salud', () => {
    it('no cuentan ni se cortan aunque el límite global (100 por minuto) se haya pasado', async () => {
      const jwks = () =>
        http().get('/.well-known/jwks.json').set('X-Forwarded-For', '203.0.113.30');
      for (let i = 0; i < 100; i++) await jwks().expect(200);
      await jwks().expect(429);

      for (const ruta of ['/identity/v1/health', '/identity/v1/health/ready']) {
        await http().get(ruta).set('X-Forwarded-For', '203.0.113.30').expect(200);
      }
    });
  });
});
