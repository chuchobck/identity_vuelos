import { NestExpressApplication } from '@nestjs/platform-express';
import * as request from 'supertest';
import { decodeJwt } from 'jose';
import { AuthService } from '../src/modules/auth/auth.service';
import { SCOPE_EVENTOS, SCOPE_OPERACIONES, SCOPES_POR_ROL } from '../src/modules/auth/scopes';
import { hashearTokenRefresco } from '../src/modules/auth/seguridad/token-refresco';
import { PrismaService } from '../src/prisma/prisma.service';
import { crearApp } from './utils/crear-app';
import {
  CONTRASENA_PRUEBA,
  correoDePrueba,
  crearUsuario,
  desactivarDatosDePrueba,
  desactivarUsuario,
  DOMINIO_PRUEBAS,
  iniciarSesion,
} from './utils/cuentas';
import { LimitesReiniciables } from './utils/limites';
import { esperarProblemDetails } from './utils/problem-details';
import { RelojDePrueba } from './utils/reloj';

const AUTH = '/identity/v1/auth';
const SCOPES_CLIENTE = [
  'flights:read',
  'flights:hold',
  'flights:book',
  'flights:cancel',
  'flights:webhooks',
];

/**
 * Cuentas de personas contra la base real, con la misma forma que /flights/v1/auth del core.
 * Los contadores de límites se reinician entre pruebas (los límites tienen su propia prueba) y
 * el reloj es de prueba: los vencimientos se prueban adelantándolo, sin esperas.
 */
describe('Auth de personas', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const reloj = new RelojDePrueba();
  const limites = new LimitesReiniciables();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await crearApp({ reloj, limites });
    prisma = app.get(PrismaService);
  });

  beforeEach(() => {
    reloj.alPresente();
    limites.reiniciar();
  });

  afterAll(async () => {
    await desactivarDatosDePrueba(app);
    await app.close();
  });

  const tokensDeLaFamilia = (refreshToken: string) =>
    prisma.db.token_refresco
      .findUniqueOrThrow({ where: { hash_token: hashearTokenRefresco(refreshToken) } })
      .then(({ id_familia }) =>
        prisma.db.token_refresco.findMany({
          where: { id_familia },
          orderBy: { fecha_creacion: 'asc' },
        }),
      );

  describe('POST /auth/register', () => {
    it('crea la cuenta con el correo normalizado, el rol cliente y sin datos internos', async () => {
      const correo = correoDePrueba();
      const respuesta = await http()
        .post(`${AUTH}/register`)
        .send({ email: `  ${correo.toUpperCase()} `, password: CONTRASENA_PRUEBA })
        .expect(201);

      expect(respuesta.body).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        email: correo,
        roles: ['cliente'],
        scopes: SCOPES_CLIENTE,
        createdAt: expect.any(String),
      });
      expect(respuesta.headers['cache-control']).toBe('no-store');
      const fila = await prisma.db.usuario.findUniqueOrThrow({ where: { correo } });
      expect(fila.hash_contrasena).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
      expect(JSON.stringify(respuesta.body)).not.toContain('argon2');
    });

    it('un correo ya registrado (con otra capitalización) responde 409', async () => {
      const usuario = await crearUsuario(app);
      const respuesta = await http()
        .post(`${AUTH}/register`)
        .send({ email: usuario.correo.toUpperCase(), password: CONTRASENA_PRUEBA });

      expect(respuesta.status).toBe(409);
      esperarProblemDetails(respuesta);
      expect(respuesta.body.detail).toBe('An account with this email already exists');
    });

    it.each([
      ['contraseña de 11 caracteres', { email: correoDePrueba(), password: 'x'.repeat(11) }],
      ['contraseña de 129 caracteres', { email: correoDePrueba(), password: 'x'.repeat(129) }],
      ['correo inválido', { email: 'no-es-un-correo', password: CONTRASENA_PRUEBA }],
      ['HTML en el correo', { email: `<b>@${DOMINIO_PRUEBAS}`, password: CONTRASENA_PRUEBA }],
      ['un campo extra (rol)', { email: correoDePrueba(), password: CONTRASENA_PRUEBA, rol: 'x' }],
    ])('rechaza %s con 400 y sin repetir la contraseña', async (_caso, cuerpo) => {
      const respuesta = await http().post(`${AUTH}/register`).send(cuerpo);

      expect(respuesta.status).toBe(400);
      esperarProblemDetails(respuesta);
      expect(JSON.stringify(respuesta.body)).not.toContain(cuerpo.password);
      expect(respuesta.headers['cache-control']).toBe('no-store');
    });

    it('acepta 12 y 128 caracteres, sin reglas de composición', async () => {
      for (const password of ['a'.repeat(12), 'a'.repeat(128)]) {
        await http()
          .post(`${AUTH}/register`)
          .send({ email: correoDePrueba(), password })
          .expect(201);
      }
    });

    it('un cuerpo que no es JSON responde 415', async () => {
      const respuesta = await http()
        .post(`${AUTH}/register`)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(`email=${correoDePrueba()}&password=${CONTRASENA_PRUEBA}`);
      expect(respuesta.status).toBe(415);
      esperarProblemDetails(respuesta);
    });
  });

  describe('POST /auth/login', () => {
    it('con las credenciales correctas entrega los tokens con los nombres de OAuth 2.0', async () => {
      const usuario = await crearUsuario(app);
      const respuesta = await http()
        .post(`${AUTH}/login`)
        .send({ email: usuario.correo.toUpperCase(), password: usuario.contrasena })
        .expect(200);

      expect(respuesta.body).toEqual({
        access_token: expect.stringMatching(/^ey[\w-]+\.[\w-]+\.[\w-]+$/),
        token_type: 'Bearer',
        expires_in: 900,
        refresh_token: expect.stringMatching(/^[\w-]{43}$/),
        scope: SCOPES_CLIENTE.join(' '),
      });
      expect(respuesta.headers['cache-control']).toBe('no-store');
      expect(respuesta.headers['pragma']).toBe('no-cache');
    });

    it('contraseña errónea, correo inexistente y cuenta inactiva responden exactamente igual', async () => {
      const usuario = await crearUsuario(app);
      const inactivo = await crearUsuario(app);
      await desactivarUsuario(app, inactivo);

      const intentos = await Promise.all([
        http()
          .post(`${AUTH}/login`)
          .send({ email: usuario.correo, password: 'otra frase equivocada' }),
        http().post(`${AUTH}/login`).send({ email: correoDePrueba(), password: CONTRASENA_PRUEBA }),
        // La contraseña es la correcta, pero la cuenta está desactivada
        http()
          .post(`${AUTH}/login`)
          .send({ email: inactivo.correo, password: inactivo.contrasena }),
      ]);

      for (const respuesta of intentos) {
        expect(respuesta.status).toBe(401);
        esperarProblemDetails(respuesta);
        expect(respuesta.headers['www-authenticate']).toBe('Bearer realm="quinde-identity"');
        expect(respuesta.headers['cache-control']).toBe('no-store');
      }
      const [primero, ...demas] = intentos;
      // Salvo el correlation_id, que es de cada petición y no dice nada de la cuenta
      const sinCorrelacion = ({ correlation_id: _id, ...resto }: Record<string, unknown>) => resto;
      for (const respuesta of demas) {
        expect(sinCorrelacion(respuesta.body)).toEqual(sinCorrelacion(primero.body));
      }
      expect(primero.body.detail).toBe('Invalid email or password');
    });

    it('los tres casos tardan parecido: siempre se corre argon2 (no se puede enumerar correos)', async () => {
      const usuario = await crearUsuario(app);
      const inactivo = await crearUsuario(app);
      await desactivarUsuario(app, inactivo);
      const servicio = app.get(AuthService);
      const casos = {
        contrasenaErronea: { email: usuario.correo, password: 'otra frase equivocada' },
        correoInexistente: { email: correoDePrueba(), password: CONTRASENA_PRUEBA },
        cuentaInactiva: { email: inactivo.correo, password: inactivo.contrasena },
      };

      const medianas: Record<string, number> = {};
      for (const [caso, credenciales] of Object.entries(casos)) {
        const tiempos: number[] = [];
        for (let i = 0; i < 7; i++) {
          const inicio = process.hrtime.bigint();
          await expect(servicio.iniciarSesion(credenciales)).rejects.toThrow();
          tiempos.push(Number(process.hrtime.bigint() - inicio) / 1e6);
        }
        medianas[caso] = tiempos.sort((x, y) => x - y)[3];
      }
      const valores = Object.values(medianas);
      // argon2 (~30-60 ms) domina; sin él, el correo inexistente tardaría una consulta (~1 ms)
      expect(Math.min(...valores)).toBeGreaterThan(10);
      expect(Math.max(...valores) / Math.min(...valores)).toBeLessThan(2);
    });
  });

  describe('POST /auth/refresh', () => {
    it('rota el token: entrega uno nuevo y el usado queda marcado como reemplazado', async () => {
      const sesion = await iniciarSesion(app, await crearUsuario(app));

      const respuesta = await http()
        .post(`${AUTH}/refresh`)
        .send({ refresh_token: sesion.refresh_token })
        .expect(200);

      expect(respuesta.body.refresh_token).not.toBe(sesion.refresh_token);
      expect(respuesta.body.access_token).not.toBe(sesion.access_token);
      expect(respuesta.headers['cache-control']).toBe('no-store');

      // Por hash y no por fecha: con el reloj de prueba quieto, las dos tienen la misma
      const porHash = (token: string) =>
        prisma.db.token_refresco.findUniqueOrThrow({
          where: { hash_token: hashearTokenRefresco(token) },
        });
      const usado = await porHash(sesion.refresh_token);
      const nuevo = await porHash(respuesta.body.refresh_token);
      expect(nuevo.id_familia).toBe(usado.id_familia);
      expect(usado.reemplazado_por_id).toBe(nuevo.id);
      expect(usado.fecha_revocacion).toBeNull();
      expect(nuevo.hash_token).toBe(hashearTokenRefresco(respuesta.body.refresh_token));
      // Solo se guarda el hash: el token no aparece en la fila
      expect(JSON.stringify(nuevo)).not.toContain(respuesta.body.refresh_token);
    });

    it('reusar un token ya rotado revoca la familia completa, también el token vigente', async () => {
      const sesion = await iniciarSesion(app, await crearUsuario(app));
      const segundo = await http()
        .post(`${AUTH}/refresh`)
        .send({ refresh_token: sesion.refresh_token })
        .expect(200);

      const reuso = await http()
        .post(`${AUTH}/refresh`)
        .send({ refresh_token: sesion.refresh_token });
      expect(reuso.status).toBe(401);
      esperarProblemDetails(reuso);
      expect(reuso.headers['www-authenticate']).toContain('error="invalid_token"');

      // El dueño legítimo también pierde la sesión: tiene que volver a iniciarla
      await http()
        .post(`${AUTH}/refresh`)
        .send({ refresh_token: segundo.body.refresh_token })
        .expect(401);

      const familia = await tokensDeLaFamilia(sesion.refresh_token);
      expect(familia.map((t) => t.motivo_revocacion)).toEqual(['REUTILIZACION', 'REUTILIZACION']);
    });

    it('dos refresh simultáneos con el mismo token: uno gana y el otro revoca la familia', async () => {
      const sesion = await iniciarSesion(app, await crearUsuario(app));

      const respuestas = await Promise.all(
        [1, 2].map(() =>
          http().post(`${AUTH}/refresh`).send({ refresh_token: sesion.refresh_token }),
        ),
      );

      expect(respuestas.map((r) => r.status).sort()).toEqual([200, 401]);
      const ganador = respuestas.find((r) => r.status === 200);
      await http()
        .post(`${AUTH}/refresh`)
        .send({ refresh_token: ganador?.body.refresh_token })
        .expect(401);
    });

    it('un token desconocido o con formato inválido responde 401 igual que uno revocado', async () => {
      for (const refresh_token of ['A'.repeat(43), 'corto', 'x'.repeat(200)]) {
        const respuesta = await http().post(`${AUTH}/refresh`).send({ refresh_token });
        expect(respuesta.status).toBe(401);
        expect(respuesta.body.detail).toBe('The refresh token is invalid or expired');
      }
    });

    it('vence a los 7 días (con el reloj del servicio)', async () => {
      const sesion = await iniciarSesion(app, await crearUsuario(app));
      reloj.adelantar(7 * 24 * 60 + 1);

      await http()
        .post(`${AUTH}/refresh`)
        .send({ refresh_token: sesion.refresh_token })
        .expect(401);
    });

    it('si la cuenta se desactivó, responde 401 y revoca la familia', async () => {
      const usuario = await crearUsuario(app);
      const sesion = await iniciarSesion(app, usuario);
      await desactivarUsuario(app, usuario);

      await http()
        .post(`${AUTH}/refresh`)
        .send({ refresh_token: sesion.refresh_token })
        .expect(401);
      const [token] = await tokensDeLaFamilia(sesion.refresh_token);
      expect(token.motivo_revocacion).toBe('USUARIO_INACTIVO');
    });
  });

  describe('POST /auth/logout', () => {
    it('revoca la sesión del usuario: su refresh deja de servir', async () => {
      const sesion = await iniciarSesion(app, await crearUsuario(app));

      await http()
        .post(`${AUTH}/logout`)
        .set('Authorization', `Bearer ${sesion.access_token}`)
        .send({ refresh_token: sesion.refresh_token })
        .expect(204);

      await http()
        .post(`${AUTH}/refresh`)
        .send({ refresh_token: sesion.refresh_token })
        .expect(401);
      const [token] = await tokensDeLaFamilia(sesion.refresh_token);
      expect(token.motivo_revocacion).toBe('CIERRE_SESION');
    });

    it('no toca el refresh de otro usuario y responde 204 igual (no revela si existía)', async () => {
      const ana = await iniciarSesion(app, await crearUsuario(app));
      const beto = await iniciarSesion(app, await crearUsuario(app));

      await http()
        .post(`${AUTH}/logout`)
        .set('Authorization', `Bearer ${ana.access_token}`)
        .send({ refresh_token: beto.refresh_token })
        .expect(204);

      await http().post(`${AUTH}/refresh`).send({ refresh_token: beto.refresh_token }).expect(200);
    });

    it('sin token de acceso responde 401', async () => {
      const respuesta = await http()
        .post(`${AUTH}/logout`)
        .send({ refresh_token: 'A'.repeat(43) });
      expect(respuesta.status).toBe(401);
      expect(respuesta.headers['www-authenticate']).toBe('Bearer realm="quinde-identity"');
    });
  });

  describe('GET /auth/me', () => {
    it('devuelve el perfil del usuario del token, con los scopes de sus roles', async () => {
      const admin = await crearUsuario(app, { administrador: true });
      const sesion = await iniciarSesion(app, admin);

      const respuesta = await http()
        .get(`${AUTH}/me`)
        .set('Authorization', `Bearer ${sesion.access_token}`)
        .expect(200);

      expect(respuesta.body).toMatchObject({
        id: admin.id,
        email: admin.correo,
        roles: expect.arrayContaining(['cliente', 'administrador']),
        scopes: [...SCOPES_CLIENTE, 'flights:ops', 'flights:admin'],
      });
      expect(sesion.scope).toBe([...SCOPES_CLIENTE, 'flights:ops', 'flights:admin'].join(' '));
      expect(respuesta.headers['cache-control']).toBe('no-store');
    });

    it('flights:ops: el administrador lo trae en login, refresh y /me; el cliente no', async () => {
      expect(SCOPES_POR_ROL.cliente).not.toContain(SCOPE_OPERACIONES);
      expect(SCOPES_POR_ROL.administrador).toContain(SCOPE_OPERACIONES);
      for (const [administrador, esperado] of [
        [true, true],
        [false, false],
      ] as const) {
        const sesion = await iniciarSesion(app, await crearUsuario(app, { administrador }));
        const refrescada = await http()
          .post(`${AUTH}/refresh`)
          .send({ refresh_token: sesion.refresh_token })
          .expect(200);
        const perfil = await http()
          .get(`${AUTH}/me`)
          .set('Authorization', `Bearer ${refrescada.body.access_token}`)
          .expect(200);
        for (const scope of [
          sesion.scope,
          decodeJwt(sesion.access_token).scope,
          refrescada.body.scope,
          decodeJwt(refrescada.body.access_token).scope,
        ]) {
          expect(String(scope).split(' ').includes(SCOPE_OPERACIONES)).toBe(esperado);
        }
        expect(perfil.body.scopes.includes(SCOPE_OPERACIONES)).toBe(esperado);
      }
    });

    it('ningún rol de persona recibe events:publish: ni en el login, ni en el refresh, ni en /me', async () => {
      expect(Object.values(SCOPES_POR_ROL).flat()).not.toContain(SCOPE_EVENTOS);
      for (const administrador of [false, true]) {
        const sesion = await iniciarSesion(app, await crearUsuario(app, { administrador }));
        const refrescada = await http()
          .post(`${AUTH}/refresh`)
          .send({ refresh_token: sesion.refresh_token })
          .expect(200);
        const perfil = await http()
          .get(`${AUTH}/me`)
          .set('Authorization', `Bearer ${refrescada.body.access_token}`)
          .expect(200);

        for (const scope of [
          sesion.scope,
          decodeJwt(sesion.access_token).scope,
          refrescada.body.scope,
          decodeJwt(refrescada.body.access_token).scope,
        ]) {
          expect(String(scope).split(' ')).not.toContain(SCOPE_EVENTOS);
        }
        expect(perfil.body.scopes).not.toContain(SCOPE_EVENTOS);
      }
    });

    it('con la cuenta desactivada después del login responde 401', async () => {
      const usuario = await crearUsuario(app);
      const sesion = await iniciarSesion(app, usuario);
      await desactivarUsuario(app, usuario);

      const respuesta = await http()
        .get(`${AUTH}/me`)
        .set('Authorization', `Bearer ${sesion.access_token}`);
      expect(respuesta.status).toBe(401);
      expect(respuesta.body.detail).toBe('The account is not active');
    });

    it('el token de acceso vence a los 15 minutos (con el reloj del servicio)', async () => {
      const sesion = await iniciarSesion(app, await crearUsuario(app));
      reloj.adelantar(14);
      await http()
        .get(`${AUTH}/me`)
        .set('Authorization', `Bearer ${sesion.access_token}`)
        .expect(200);

      reloj.adelantar(2);
      const respuesta = await http()
        .get(`${AUTH}/me`)
        .set('Authorization', `Bearer ${sesion.access_token}`);
      expect(respuesta.status).toBe(401);
      expect(respuesta.body.detail).toBe('The access token expired');
    });

    it('sin token, con otro esquema o con basura responde 401 con WWW-Authenticate', async () => {
      for (const cabecera of [undefined, 'Basic dXN1YXJpbzpjbGF2ZQ==', 'Bearer no.es.jwt']) {
        const peticion = http().get(`${AUTH}/me`);
        if (cabecera) peticion.set('Authorization', cabecera);
        const respuesta = await peticion;
        expect(respuesta.status).toBe(401);
        esperarProblemDetails(respuesta);
        expect(respuesta.headers['www-authenticate']).toMatch(/^Bearer realm="quinde-identity"/);
      }
    });
  });
});
