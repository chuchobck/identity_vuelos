import { NestExpressApplication } from '@nestjs/platform-express';
import { decodeJwt } from 'jose';
import * as request from 'supertest';
import {
  AltaClienteInvalida,
  ClienteCreado,
  validarAltaCliente,
} from '../src/modules/oauth2/clientes/alta-cliente';
import { PrismaService } from '../src/prisma/prisma.service';
import { crearApp } from './utils/crear-app';
import {
  basic,
  crearClienteDePrueba,
  desactivarCliente,
  desactivarDatosDePrueba,
} from './utils/cuentas';
import { LimitesReiniciables } from './utils/limites';
import { esperarErrorOAuth } from './utils/problem-details';
import { RelojDePrueba } from './utils/reloj';

const TOKEN = '/oauth2/token';
const CC = { grant_type: 'client_credentials' };

/**
 * POST /oauth2/token con grant_type=client_credentials (RFC 6749, sección 4.4) contra la base
 * real. Los errores tienen que salir con el formato de RFC 6749, nunca como ProblemDetails.
 */
describe('OAuth 2.0 client_credentials', () => {
  let app: NestExpressApplication;
  let cliente: ClienteCreado;
  const reloj = new RelojDePrueba();
  const limites = new LimitesReiniciables();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await crearApp({ reloj, limites });
    cliente = await crearClienteDePrueba(app, { scopes: 'flights:read flights:hold' });
  });

  beforeEach(() => {
    reloj.alPresente();
    limites.reiniciar();
  });

  afterAll(async () => {
    await desactivarDatosDePrueba(app);
    await app.close();
  });

  const pedir = (cuerpo: Record<string, string>, autorizacion?: string) => {
    const peticion = http().post(TOKEN).type('form');
    if (autorizacion) peticion.set('Authorization', autorizacion);
    return peticion.send(cuerpo);
  };

  describe('cliente válido', () => {
    it('con Authorization: Basic recibe un token sin refresh_token y con no-store', async () => {
      const respuesta = await pedir(CC, basic(cliente.clientId, cliente.secreto)).expect(200);

      expect(respuesta.body).toEqual({
        access_token: expect.stringMatching(/^ey[\w-]+\.[\w-]+\.[\w-]+$/),
        token_type: 'Bearer',
        expires_in: 900,
        scope: 'flights:read flights:hold',
      });
      expect(respuesta.body.refresh_token).toBeUndefined();
      expect(respuesta.headers['cache-control']).toBe('no-store');
      expect(respuesta.headers['pragma']).toBe('no-cache');
      const claims = decodeJwt(respuesta.body.access_token);
      expect(claims.sub).toBe(cliente.id);
      expect(claims.client_id).toBe(cliente.clientId);
    });

    it('con client_id y client_secret en el cuerpo (client_secret_post) también', async () => {
      const respuesta = await pedir({
        ...CC,
        client_id: cliente.clientId,
        client_secret: cliente.secreto,
        scope: 'flights:read',
      }).expect(200);
      expect(respuesta.body.scope).toBe('flights:read');
    });

    it('un client_id repetido en el cuerpo, igual al de Basic, se acepta', async () => {
      await pedir(
        { ...CC, client_id: cliente.clientId },
        basic(cliente.clientId, cliente.secreto),
      ).expect(200);
    });
  });

  describe('autenticación del cliente: invalid_client 401 con WWW-Authenticate', () => {
    const esperarClienteInvalido = (respuesta: request.Response) => {
      esperarErrorOAuth(respuesta, 401, 'invalid_client');
      expect(respuesta.headers['www-authenticate']).toBe(
        'Basic realm="quinde-identity", charset="UTF-8"',
      );
      expect(respuesta.headers['cache-control']).toBe('no-store');
    };

    it('secreto errado, cliente desconocido y cliente inactivo responden exactamente igual', async () => {
      const inactivo = await crearClienteDePrueba(app, { scopes: 'flights:read' });
      await desactivarCliente(app, inactivo);

      const respuestas = [
        await pedir(CC, basic(cliente.clientId, 'no-es-el-secreto')),
        await pedir(CC, basic('e2e-no-existe', cliente.secreto)),
        // El secreto es el correcto, pero el cliente está dado de baja
        await pedir(CC, basic(inactivo.clientId, inactivo.secreto)),
      ];
      for (const respuesta of respuestas) esperarClienteInvalido(respuesta);
      const [primero, ...demas] = respuestas;
      for (const respuesta of demas) expect(respuesta.body).toEqual(primero.body);
    });

    it.each([
      ['sin credenciales', undefined],
      ['con otro esquema (Bearer)', 'Bearer algo'],
      ['con un Basic ilegible', 'Basic %%%'],
      ['con un Basic sin ":"', `Basic ${Buffer.from('solo-id').toString('base64')}`],
    ])('%s', async (_caso, autorizacion) => {
      esperarClienteInvalido(await pedir(CC, autorizacion));
    });
  });

  describe('scope', () => {
    it('fuera de lo permitido: invalid_scope 400, sin entregar un subconjunto', async () => {
      const respuesta = await pedir(
        { ...CC, scope: 'flights:read flights:book' },
        basic(cliente.clientId, cliente.secreto),
      );
      esperarErrorOAuth(respuesta, 400, 'invalid_scope');
    });

    it.each([['flights:root'], [''], ['   ']])(
      'desconocido o vacío (%j): invalid_scope 400',
      async (scope) => {
        const respuesta = await pedir({ ...CC, scope }, basic(cliente.clientId, cliente.secreto));
        esperarErrorOAuth(respuesta, 400, 'invalid_scope');
      },
    );
  });

  describe('flights:admin', () => {
    it('un cliente que no lo tiene permitido no lo recibe aunque lo pida', async () => {
      const respuesta = await pedir(
        { ...CC, scope: 'flights:read flights:admin' },
        basic(cliente.clientId, cliente.secreto),
      );
      esperarErrorOAuth(respuesta, 400, 'invalid_scope');
    });

    it('permitido pero no pedido: no sale (hay que pedirlo de forma explícita)', async () => {
      const admin = await crearClienteDePrueba(app, {
        scopes: 'flights:read flights:admin',
        permitirAdmin: true,
      });
      const respuesta = await pedir(CC, basic(admin.clientId, admin.secreto)).expect(200);
      expect(respuesta.body.scope).toBe('flights:read');
      expect(decodeJwt(respuesta.body.access_token).scope).toBe('flights:read');
    });

    it('permitido y pedido: sale', async () => {
      const admin = await crearClienteDePrueba(app, {
        scopes: 'flights:read flights:admin',
        permitirAdmin: true,
      });
      const respuesta = await pedir(
        { ...CC, scope: 'flights:admin' },
        basic(admin.clientId, admin.secreto),
      ).expect(200);
      expect(respuesta.body.scope).toBe('flights:admin');
    });

    it('un cliente solo de administración tiene que pedir su scope', async () => {
      const admin = await crearClienteDePrueba(app, {
        scopes: 'flights:admin',
        permitirAdmin: true,
      });
      esperarErrorOAuth(
        await pedir(CC, basic(admin.clientId, admin.secreto)),
        400,
        'invalid_scope',
      );
    });

    it('el alta de un cliente con flights:admin exige --permitir-admin', () => {
      expect(() =>
        validarAltaCliente({ nombre: 'Batch', scopes: 'flights:read flights:admin' }),
      ).toThrow(AltaClienteInvalida);
      expect(
        validarAltaCliente({ nombre: 'Batch', scopes: 'flights:admin', permitirAdmin: true })
          .scopes,
      ).toEqual(['flights:admin']);
    });

    it('el alta rechaza scopes que no existen y client_id con ":" o mayúsculas', () => {
      expect(() => validarAltaCliente({ nombre: 'X', scopes: 'flights:root' })).toThrow(
        AltaClienteInvalida,
      );
      for (const clientId of ['Con:Dos', 'MAYUS', 'ab']) {
        expect(() => validarAltaCliente({ nombre: 'X', scopes: 'flights:read', clientId })).toThrow(
          AltaClienteInvalida,
        );
      }
    });

    it('el secreto se guarda solo como hash argon2id', async () => {
      const fila = await app
        .get(PrismaService)
        .db.cliente_oauth.findUniqueOrThrow({ where: { id: cliente.id } });
      expect(fila.hash_secreto).toMatch(/^\$argon2id\$v=19\$/);
      expect(JSON.stringify(fila)).not.toContain(cliente.secreto);
    });
  });

  describe('events:publish (solo de máquina a máquina)', () => {
    it('permitido y pedido: sale, solo o con otros scopes', async () => {
      const servicio = await crearClienteDePrueba(app, {
        scopes: 'flights:read events:publish',
        permitirEventos: true,
      });
      const solo = await pedir(
        { ...CC, scope: 'events:publish' },
        basic(servicio.clientId, servicio.secreto),
      ).expect(200);
      expect(solo.body.scope).toBe('events:publish');
      expect(decodeJwt(solo.body.access_token)).toMatchObject({
        scope: 'events:publish',
        sub: servicio.id,
        client_id: servicio.clientId,
      });

      const ambos = await pedir(
        { ...CC, scope: 'events:publish flights:read' },
        basic(servicio.clientId, servicio.secreto),
      ).expect(200);
      expect(ambos.body.scope).toBe('flights:read events:publish');
    });

    it('permitido pero no pedido: no sale (nunca por defecto)', async () => {
      const servicio = await crearClienteDePrueba(app, {
        scopes: 'flights:read flights:admin events:publish',
        permitirAdmin: true,
        permitirEventos: true,
      });
      const respuesta = await pedir(CC, basic(servicio.clientId, servicio.secreto)).expect(200);
      expect(respuesta.body.scope).toBe('flights:read');
      expect(decodeJwt(respuesta.body.access_token).scope).toBe('flights:read');
    });

    it('un cliente que solo publica eventos tiene que pedir su scope', async () => {
      const servicio = await crearClienteDePrueba(app, {
        scopes: 'events:publish',
        permitirEventos: true,
      });
      esperarErrorOAuth(
        await pedir(CC, basic(servicio.clientId, servicio.secreto)),
        400,
        'invalid_scope',
      );
    });

    it('pedido sin tenerlo permitido: invalid_scope 400, aunque tenga flights:admin', async () => {
      const admin = await crearClienteDePrueba(app, {
        scopes: 'flights:read flights:admin',
        permitirAdmin: true,
      });
      for (const scope of ['events:publish', 'flights:read events:publish']) {
        esperarErrorOAuth(
          await pedir({ ...CC, scope }, basic(admin.clientId, admin.secreto)),
          400,
          'invalid_scope',
        );
      }
    });

    it('el alta con events:publish exige --permitir-eventos (no basta --permitir-admin)', () => {
      expect(() => validarAltaCliente({ nombre: 'Core', scopes: 'events:publish' })).toThrow(
        /--permitir-eventos/,
      );
      expect(() =>
        validarAltaCliente({ nombre: 'Core', scopes: 'events:publish', permitirAdmin: true }),
      ).toThrow(AltaClienteInvalida);
      expect(
        validarAltaCliente({
          nombre: 'Core',
          scopes: 'events:publish, flights:read',
          permitirEventos: true,
        }).scopes,
      ).toEqual(['flights:read', 'events:publish']);
    });
  });

  describe('forma de la petición', () => {
    it('grant_type ajeno: unsupported_grant_type 400', async () => {
      for (const grant_type of ['password', 'authorization_code', 'refresh_token']) {
        const respuesta = await pedir({ grant_type }, basic(cliente.clientId, cliente.secreto));
        esperarErrorOAuth(respuesta, 400, 'unsupported_grant_type');
      }
    });

    it('sin grant_type: invalid_request 400', async () => {
      esperarErrorOAuth(
        await pedir({}, basic(cliente.clientId, cliente.secreto)),
        400,
        'invalid_request',
      );
    });

    it('un parámetro repetido: invalid_request 400', async () => {
      const respuesta = await http()
        .post(TOKEN)
        .set('Authorization', basic(cliente.clientId, cliente.secreto))
        .type('form')
        .send('grant_type=client_credentials&scope=flights:read&scope=flights:hold');
      esperarErrorOAuth(respuesta, 400, 'invalid_request');
    });

    it('dos métodos de autenticación a la vez: invalid_request 400', async () => {
      const respuesta = await pedir(
        { ...CC, client_secret: cliente.secreto },
        basic(cliente.clientId, cliente.secreto),
      );
      esperarErrorOAuth(respuesta, 400, 'invalid_request');
    });

    it('JSON en lugar de formulario: invalid_request 400 (no ProblemDetails)', async () => {
      const respuesta = await http()
        .post(TOKEN)
        .set('Authorization', basic(cliente.clientId, cliente.secreto))
        .send(CC);
      esperarErrorOAuth(respuesta, 400, 'invalid_request');
    });

    it('un cuerpo de más de 100 kB: invalid_request 400 (no ProblemDetails)', async () => {
      const respuesta = await http()
        .post(TOKEN)
        .type('form')
        .send(`grant_type=client_credentials&x=${'a'.repeat(110_000)}`);
      esperarErrorOAuth(respuesta, 400, 'invalid_request');
    });

    it('GET: 405 con Allow y el formato de RFC 6749', async () => {
      const respuesta = await http().get(TOKEN);
      esperarErrorOAuth(respuesta, 405, 'invalid_request');
      expect(respuesta.headers['allow']).toBe('POST');
    });
  });

  describe('el token de un cliente no sirve como el de una persona', () => {
    it('GET /identity/v1/auth/me responde 401', async () => {
      const { body } = await pedir(CC, basic(cliente.clientId, cliente.secreto)).expect(200);
      const respuesta = await http()
        .get('/identity/v1/auth/me')
        .set('Authorization', `Bearer ${body.access_token}`);
      expect(respuesta.status).toBe(401);
      expect(respuesta.body.detail).toBe('The access token does not belong to a user account');
    });
  });
});
