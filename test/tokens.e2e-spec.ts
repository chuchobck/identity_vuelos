import { NestExpressApplication } from '@nestjs/platform-express';
import { decodeJwt, decodeProtectedHeader, JWTPayload, SignJWT } from 'jose';
import { createPrivateKey, generateKeyPairSync, KeyObject, randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { AUDIENCIA_PRUEBAS, EMISOR_PRUEBAS, pemDe } from './utils/claves';
import { crearApp, escuchar } from './utils/crear-app';
import {
  basic,
  crearClienteDePrueba,
  crearUsuario,
  desactivarDatosDePrueba,
  UsuarioDePrueba,
} from './utils/cuentas';
import { LimitesReiniciables } from './utils/limites';
import { crearVerificador } from './utils/verificador';

const AUTH = '/identity/v1/auth';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Los tokens contra un consumidor externo: un verificador con `jose` y createRemoteJWKSet que
 * baja /.well-known/jwks.json por HTTP, sin usar el código del servicio (como lo hará el core).
 * Cada ataque se prueba dos veces: contra ese verificador y contra el propio servicio
 * (GET /auth/me), que debe rechazarlo con 401.
 */
describe('Tokens RS256 y JWKS', () => {
  let app: NestExpressApplication;
  let urlBase: string;
  let verificar: ReturnType<typeof crearVerificador>;
  let usuario: UsuarioDePrueba;
  let kid: string;
  const limites = new LimitesReiniciables();
  const clavePrivada: KeyObject = createPrivateKey(pemDe(process.env.JWT_SIGNING_KEY ?? ''));
  const atacante = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await crearApp({ limites });
    urlBase = await escuchar(app);
    verificar = crearVerificador(urlBase);
    usuario = await crearUsuario(app);
    const { body } = await http().get('/.well-known/jwks.json').expect(200);
    kid = body.keys[0].kid;
  });

  beforeEach(() => limites.reiniciar());

  afterAll(async () => {
    await desactivarDatosDePrueba(app);
    await app.close();
  });

  const login = async (u: UsuarioDePrueba) =>
    (
      await http()
        .post(`${AUTH}/login`)
        .send({ email: u.correo, password: u.contrasena })
        .expect(200)
    ).body as { access_token: string; scope: string };

  /** Claims válidos de una persona; cada ataque cambia uno. */
  const claimsValidos = (): JWTPayload => {
    const ahora = Math.floor(Date.now() / 1000);
    return {
      iss: EMISOR_PRUEBAS,
      sub: usuario.id,
      aud: AUDIENCIA_PRUEBAS,
      iat: ahora,
      exp: ahora + 900,
      jti: randomUUID(),
      scope: 'flights:read',
    };
  };

  const forjar = (
    claims: JWTPayload,
    cabecera: { alg?: string; kid?: string; typ?: string } = {},
    clave: KeyObject | Uint8Array = clavePrivada,
  ) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid, ...cabecera })
      .sign(clave);

  const b64 = (valor: object) => Buffer.from(JSON.stringify(valor)).toString('base64url');

  /** El servicio lo rechaza en /auth/me con 401 invalid_token. */
  const esperarRechazoDelServicio = async (token: string) => {
    const respuesta = await http().get(`${AUTH}/me`).set('Authorization', `Bearer ${token}`);
    expect(respuesta.status).toBe(401);
    expect(respuesta.headers['www-authenticate']).toContain('error="invalid_token"');
  };

  describe('un consumidor externo valida lo que firma el servicio', () => {
    it('el token del login: cabecera y claims de RFC 9068', async () => {
      const { access_token } = await login(usuario);
      const { payload, protectedHeader } = await verificar(access_token);

      expect(protectedHeader).toEqual({ alg: 'RS256', typ: 'at+jwt', kid });
      expect(payload).toEqual({
        iss: EMISOR_PRUEBAS,
        sub: usuario.id,
        aud: AUDIENCIA_PRUEBAS,
        iat: expect.any(Number),
        exp: expect.any(Number),
        jti: expect.stringMatching(UUID),
        scope: 'flights:read flights:hold flights:book flights:cancel flights:webhooks',
      });
      expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(900);
      expect(payload.client_id).toBeUndefined();
    });

    it('el token de un cliente lleva su uuid en sub y además client_id', async () => {
      const cliente = await crearClienteDePrueba(app, { scopes: 'flights:read flights:hold' });
      const { body } = await http()
        .post('/oauth2/token')
        .set('Authorization', basic(cliente.clientId, cliente.secreto))
        .type('form')
        .send({ grant_type: 'client_credentials' })
        .expect(200);

      const { payload, protectedHeader } = await verificar(body.access_token);
      expect(protectedHeader.typ).toBe('at+jwt');
      expect(payload.sub).toBe(cliente.id);
      expect(payload.sub).toMatch(UUID);
      expect(payload.client_id).toBe(cliente.clientId);
      expect(payload.scope).toBe('flights:read flights:hold');
    });

    it('control: un token forjado con la clave real y claims válidos pasa en los dos lados', async () => {
      const token = await forjar(claimsValidos());
      await expect(verificar(token)).resolves.toBeDefined();
      await http().get(`${AUTH}/me`).set('Authorization', `Bearer ${token}`).expect(200);
    });
  });

  describe('el JWKS y el descubrimiento', () => {
    it('publica solo la parte pública, con kid, RS256, sig y caché de 5 minutos', async () => {
      const respuesta = await http().get('/.well-known/jwks.json').expect(200);
      expect(respuesta.headers['cache-control']).toBe('public, max-age=300');
      expect(respuesta.body.keys).toHaveLength(1);
      const [clave] = respuesta.body.keys;
      expect(Object.keys(clave).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
      expect(clave).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig', e: 'AQAB' });
      // 2048 bits = 256 bytes = 342 caracteres en base64url
      expect(Buffer.from(clave.n, 'base64url').length).toBeGreaterThanOrEqual(256);
      for (const privado of ['d', 'p', 'q', 'dp', 'dq', 'qi'])
        expect(clave[privado]).toBeUndefined();
    });

    it('openid-configuration apunta al JWKS y al token del mismo emisor', async () => {
      const respuesta = await http().get('/.well-known/openid-configuration').expect(200);
      expect(respuesta.headers['cache-control']).toBe('public, max-age=300');
      expect(respuesta.body).toEqual({
        issuer: EMISOR_PRUEBAS,
        jwks_uri: `${EMISOR_PRUEBAS}/.well-known/jwks.json`,
        token_endpoint: `${EMISOR_PRUEBAS}/oauth2/token`,
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        grant_types_supported: ['client_credentials'],
        scopes_supported: [
          'flights:read',
          'flights:hold',
          'flights:book',
          'flights:cancel',
          'flights:webhooks',
          'flights:admin',
          'events:publish',
        ],
        id_token_signing_alg_values_supported: ['RS256'],
      });
    });
  });

  describe('ataques que deben fallar en el consumidor y en el servicio', () => {
    it('alg none (sin firma)', async () => {
      const token = `${b64({ alg: 'none', typ: 'at+jwt', kid })}.${b64(claimsValidos())}.`;
      await expect(verificar(token)).rejects.toThrow();
      await esperarRechazoDelServicio(token);
    });

    it('HS256 firmado con la clave pública como secreto (confusión de algoritmo)', async () => {
      const publicaPem = new TextEncoder().encode(pemDe(process.env.PRUEBAS_JWT_PUBLIC_KEY ?? ''));
      const token = await forjar(claimsValidos(), { alg: 'HS256' }, publicaPem);
      await expect(verificar(token)).rejects.toThrow();
      await esperarRechazoDelServicio(token);
    });

    it('kid desconocido, firmado por otra clave', async () => {
      const token = await forjar(claimsValidos(), { kid: 'clave-del-atacante' }, atacante);
      await expect(verificar(token)).rejects.toThrow();
      await esperarRechazoDelServicio(token);
    });

    it('kid desconocido aunque la firma sea de la clave real', async () => {
      const token = await forjar(claimsValidos(), { kid: 'otro-kid' });
      await expect(verificar(token)).rejects.toThrow();
      await esperarRechazoDelServicio(token);
    });

    it('kid del servicio con la firma de otra clave', async () => {
      const token = await forjar(claimsValidos(), {}, atacante);
      await expect(verificar(token)).rejects.toThrow();
      await esperarRechazoDelServicio(token);
    });

    it('token vencido', async () => {
      const ahora = Math.floor(Date.now() / 1000);
      const token = await forjar({ ...claimsValidos(), iat: ahora - 3600, exp: ahora - 60 });
      await expect(verificar(token)).rejects.toThrow(/"exp" claim timestamp check failed/);
      const respuesta = await http().get(`${AUTH}/me`).set('Authorization', `Bearer ${token}`);
      expect(respuesta.status).toBe(401);
      expect(respuesta.body.detail).toBe('The access token expired');
    });

    it('iss ajeno', async () => {
      const token = await forjar({ ...claimsValidos(), iss: 'https://otro-emisor.example' });
      await expect(verificar(token)).rejects.toThrow(/"iss"/);
      await esperarRechazoDelServicio(token);
    });

    it('aud ajeno', async () => {
      const token = await forjar({ ...claimsValidos(), aud: 'otra-api' });
      await expect(verificar(token)).rejects.toThrow(/"aud"/);
      await esperarRechazoDelServicio(token);
    });

    it('token sin exp', async () => {
      const claims = claimsValidos();
      delete claims.exp;
      const token = await forjar(claims);
      await expect(verificar(token)).rejects.toThrow(/"exp"/);
      await esperarRechazoDelServicio(token);
    });

    it('typ distinto de at+jwt (un id_token u otro JWT del mismo emisor)', async () => {
      const token = await forjar(claimsValidos(), { typ: 'JWT' });
      await expect(verificar(token)).rejects.toThrow();
      await esperarRechazoDelServicio(token);
    });

    it('scope manipulado: se cambia el payload y se deja la firma original', async () => {
      const { access_token } = await login(usuario);
      const [cabecera, , firma] = access_token.split('.');
      const claims = decodeJwt(access_token);
      const manipulado = `${cabecera}.${b64({ ...claims, scope: `${claims.scope} flights:admin` })}.${firma}`;
      expect(decodeProtectedHeader(manipulado).kid).toBe(kid);

      await expect(verificar(manipulado)).rejects.toThrow(/signature verification failed/);
      await esperarRechazoDelServicio(manipulado);
    });
  });
});
