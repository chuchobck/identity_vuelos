import { NestExpressApplication } from '@nestjs/platform-express';
import { decodeJwt } from 'jose';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { TokensService } from '../src/modules/claves/tokens.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { crearApp } from './utils/crear-app';
import {
  basic,
  crearClienteDePrueba,
  crearUsuario,
  desactivarDatosDePrueba,
  DOMINIO_PRUEBAS,
  iniciarSesion,
} from './utils/cuentas';
import { LimitesReiniciables } from './utils/limites';
import { esperarProblemDetails } from './utils/problem-details';
import { RelojDePrueba } from './utils/reloj';

const USUARIOS = '/identity/v1/admin/users';
const AUTH = '/identity/v1/auth';
const CLAVE = 'una frase larga de prueba 123';
const FALTA_ADMIN = 'Missing required scopes: flights:admin';

type Admin = { id: string; email: string; createdAt: string; active: boolean };
type Metodo = 'get' | 'post' | 'delete';

/**
 * /identity/v1/admin/users contra la base real: test/admin-usuarios.e2e-spec.ts del core,
 * portado. Las reglas, los status y los cuerpos son los mismos; cambia la auditoría (aquí,
 * auditoria_seguridad con actor_id) y se agrega que el token de un cliente OAuth no entra.
 */
describe('/identity/v1/admin/users', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let idAdmin: string;
  let tokenAdmin: string;
  let tokenCliente: string;
  const reloj = new RelojDePrueba();
  const limites = new LimitesReiniciables();
  const http = () => request(app.getHttpServer());

  const conToken = (token: string | undefined, metodo: Metodo, ruta: string, cuerpo?: object) => {
    let peticion = http()[metodo](ruta);
    if (token) peticion = peticion.set('Authorization', `Bearer ${token}`);
    return cuerpo === undefined ? peticion : peticion.send(cuerpo);
  };
  const admin = (metodo: Metodo, ruta: string, cuerpo?: object) =>
    conToken(tokenAdmin, metodo, ruta, cuerpo);

  const correo = () => `e2e-adm-${randomUUID()}@${DOMINIO_PRUEBAS}`;
  const crear = (email = correo(), password = CLAVE) =>
    admin('post', USUARIOS, { email, password });
  const alta = async (): Promise<Admin & { password: string }> => {
    const r = await crear(correo()).expect(201);
    return { ...(r.body as Admin), password: CLAVE };
  };
  /** Un access token sin pasar por el límite de /auth/login (5 por minuto e IP). */
  const tokenDe = async (u: Admin & { password: string }) =>
    (await iniciarSesion(app, { id: u.id, correo: u.email, contrasena: u.password })).access_token;
  const login = (email: string, password: string) =>
    http().post(`${AUTH}/login`).send({ email, password });
  const auditoria = (usuarioId: string) =>
    prisma.db.auditoria_seguridad.findMany({
      where: {
        usuario_id: usuarioId,
        evento: { in: ['ADMINISTRADOR_CREADO', 'ADMINISTRADOR_DADO_DE_BAJA'] },
      },
      orderBy: { id: 'asc' },
    });
  const administradoresActivos = () =>
    prisma.db.usuario.count({
      where: {
        activo: true,
        usuario_rol: { some: { activo: true, rol: { codigo: 'administrador' } } },
      },
    });

  beforeAll(async () => {
    app = await crearApp({ reloj, limites });
    prisma = app.get(PrismaService);
    const yo = await crearUsuario(app, { administrador: true });
    idAdmin = yo.id;
    tokenAdmin = (await iniciarSesion(app, yo)).access_token;
    tokenCliente = (await iniciarSesion(app, await crearUsuario(app))).access_token;
  });

  beforeEach(() => {
    reloj.alPresente();
    limites.reiniciar();
  });

  afterAll(async () => {
    await desactivarDatosDePrueba(app);
    await app.close();
  });

  describe('autorización', () => {
    const rutas: Array<[Metodo, string]> = [
      ['get', USUARIOS],
      ['post', USUARIOS],
      ['delete', `${USUARIOS}/${randomUUID()}`],
    ];

    it.each(rutas)('401 sin token: %s %s', async (metodo, ruta) => {
      const r = await conToken(undefined, metodo, ruta, metodo === 'post' ? {} : undefined).expect(
        401,
      );
      esperarProblemDetails(r);
      expect(r.headers['www-authenticate']).toBe('Bearer realm="quinde-identity"');
    });

    it.each(rutas)('403 insufficient_scope con token de cliente: %s %s', async (metodo, ruta) => {
      const r = await conToken(
        tokenCliente,
        metodo,
        ruta,
        metodo === 'post' ? {} : undefined,
      ).expect(403);
      esperarProblemDetails(r);
      expect(r.body.detail).toBe(FALTA_ADMIN);
      expect(r.headers['www-authenticate']).toBe(
        `Bearer realm="quinde-identity", error="insufficient_scope", error_description="${FALTA_ADMIN}", scope="flights:admin"`,
      );
    });

    it.each(rutas)(
      '401 con el token de un cliente OAuth, aunque traiga flights:admin: %s %s',
      async (metodo, ruta) => {
        const maquina = await crearClienteDePrueba(app, {
          scopes: 'flights:admin',
          permitirAdmin: true,
        });
        const token = await http()
          .post('/oauth2/token')
          .set('Authorization', basic(maquina.clientId, maquina.secreto))
          .type('form')
          .send({ grant_type: 'client_credentials', scope: 'flights:admin' })
          .expect(200);
        expect(decodeJwt(token.body.access_token).scope).toBe('flights:admin');
        const r = await conToken(
          token.body.access_token,
          metodo,
          ruta,
          metodo === 'post' ? { email: correo(), password: CLAVE } : undefined,
        ).expect(401);
        esperarProblemDetails(r);
        expect(r.headers['www-authenticate']).toContain('error="invalid_token"');
      },
    );

    it('las respuestas (también los errores) llevan Cache-Control: no-store', async () => {
      for (const r of [
        await admin('get', USUARIOS).expect(200),
        await conToken(tokenCliente, 'get', USUARIOS).expect(403),
        await conToken(undefined, 'get', USUARIOS).expect(401),
      ]) {
        expect(r.headers['cache-control']).toBe('no-store');
      }
    });
  });

  describe('POST (crear)', () => {
    it('201 con { id, email, createdAt, active } y nunca el hash', async () => {
      const email = correo();
      const r = await crear(email).expect(201);
      expect(Object.keys(r.body).sort()).toEqual(['active', 'createdAt', 'email', 'id']);
      expect(r.body).toMatchObject({ email, active: true });
      expect(new Date(r.body.createdAt).toISOString()).toBe(r.body.createdAt);
      expect(JSON.stringify(r.body)).not.toMatch(/argon2|hash|password/i);
    });

    it('guarda un hash argon2id con el rol administrador, y la auditoría nombra al autor', async () => {
      const nuevo = await alta();
      const fila = await prisma.db.usuario.findUniqueOrThrow({
        where: { id: nuevo.id },
        include: { usuario_rol: { include: { rol: true } } },
      });
      expect(fila.hash_contrasena).toMatch(/^\$argon2id\$/);
      expect(fila.hash_contrasena).not.toContain(CLAVE);
      expect(fila.usuario_rol.map((ur) => [ur.rol.codigo, ur.activo])).toEqual([
        ['administrador', true],
      ]);
      const eventos = await auditoria(nuevo.id);
      expect(eventos).toHaveLength(1);
      // El actor es el administrador que hizo la petición, no el usuario creado
      expect(eventos[0]).toMatchObject({
        evento: 'ADMINISTRADOR_CREADO',
        resultado: 'EXITO',
        motivo: null,
        usuario_id: nuevo.id,
        actor_id: idAdmin,
        cliente_id: null,
        correo_parcial: null,
      });
      const fila_auditoria = JSON.stringify(eventos[0], (_, v: unknown) =>
        typeof v === 'bigint' ? v.toString() : v,
      );
      expect(fila_auditoria).not.toContain(CLAVE);
      expect(fila_auditoria).not.toContain(nuevo.email);
      expect(fila_auditoria).not.toContain(fila.hash_contrasena);
    });

    it('normaliza el correo como /auth/register (minúsculas y sin espacios)', async () => {
      const base = correo();
      const r = await crear(`  ${base.toUpperCase()}  `).expect(201);
      expect(r.body.email).toBe(base);
    });

    it('el nuevo administrador inicia sesión y tiene flights:admin; su rol lo fijó el servidor', async () => {
      const nuevo = await alta();
      const sesion = await login(nuevo.email, nuevo.password).expect(200);
      expect(sesion.body.scope.split(' ')).toContain('flights:admin');
      expect(sesion.body.scope.split(' ')).not.toContain('events:publish');
      const yo = await http()
        .get(`${AUTH}/me`)
        .set('Authorization', `Bearer ${sesion.body.access_token}`)
        .expect(200);
      expect(yo.body.roles).toEqual(['administrador']);
      await http()
        .get(USUARIOS)
        .set('Authorization', `Bearer ${sesion.body.access_token}`)
        .expect(200);
    });

    it('409 si el correo ya existe (también con otras mayúsculas), sin crear nada', async () => {
      const email = correo();
      const primero = await crear(email).expect(201);
      const r = await crear(email.toUpperCase()).expect(409);
      esperarProblemDetails(r);
      expect(r.body.detail).toBe('An account with this email already exists');
      expect(await prisma.db.usuario.count({ where: { correo: email } })).toBe(1);
      // El intento queda en la auditoría, con el autor y sin el correo
      const eventos = await auditoria(primero.body.id);
      expect(eventos.map((e) => [e.resultado, e.motivo, e.actor_id])).toEqual([
        ['EXITO', null, idAdmin],
        ['FALLO', 'CORREO_REGISTRADO', idAdmin],
      ]);
    });

    it('409 también si el correo es de un cliente', async () => {
      const cliente = await crearUsuario(app);
      await crear(cliente.correo).expect(409);
    });

    it('400 si falta un campo, el correo no es válido o la contraseña mide menos de 12 o más de 128', async () => {
      const casos: object[] = [
        {},
        { email: correo() },
        { password: CLAVE },
        { email: 'no-es-un-correo', password: CLAVE },
        { email: correo(), password: 'a'.repeat(11) },
        { email: correo(), password: 'a'.repeat(129) },
        { email: correo(), password: 12345678901234 },
      ];
      for (const cuerpo of casos) {
        const r = await admin('post', USUARIOS, cuerpo).expect(400);
        esperarProblemDetails(r);
      }
      // Los límites exactos sí valen
      await crear(correo(), 'a'.repeat(12)).expect(201);
      await crear(correo(), 'a'.repeat(128)).expect(201);
    });

    it('400 si el cuerpo trae un rol (el rol lo fija el servidor); no se crea la cuenta', async () => {
      for (const extra of [
        { role: 'cliente' },
        { rol: 'administrador' },
        { roles: ['x'], scopes: ['flights:admin'] },
      ]) {
        const email = correo();
        const r = await admin('post', USUARIOS, { email, password: CLAVE, ...extra }).expect(400);
        esperarProblemDetails(r);
        expect(await prisma.db.usuario.count({ where: { correo: email } })).toBe(0);
      }
    });
  });

  describe('GET (listar)', () => {
    it('lista administradores con { id, email, createdAt, active }, sin clientes ni hashes', async () => {
      const nuevo = await alta();
      const cliente = await crearUsuario(app);
      const r = await admin('get', `${USUARIOS}?limit=50`).expect(200);
      const items = r.body.items as Admin[];
      expect(items.find((a) => a.id === nuevo.id)).toEqual({
        id: nuevo.id,
        email: nuevo.email,
        createdAt: nuevo.createdAt,
        active: true,
      });
      expect(items.find((a) => a.id === cliente.id)).toBeUndefined();
      expect(items.find((a) => a.id === idAdmin)).toBeDefined();
      expect(items.every((a) => a.active)).toBe(true);
      expect(JSON.stringify(r.body)).not.toMatch(/argon2|hash/i);
      for (const a of items)
        expect(Object.keys(a).sort()).toEqual(['active', 'createdAt', 'email', 'id']);
    });

    it('pagina por cursor, del más reciente al más viejo, sin repetir', async () => {
      const creados = [await alta(), await alta(), await alta()];
      const todos = (await admin('get', `${USUARIOS}?limit=50`).expect(200)).body.items as Admin[];
      const recorridos: Admin[] = [];
      let cursor: string | undefined;
      let paginas = 0;
      do {
        const r = await admin(
          'get',
          `${USUARIOS}?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        ).expect(200);
        recorridos.push(...(r.body.items as Admin[]));
        cursor = r.body.nextCursor;
        if (cursor) expect(r.body.items).toHaveLength(2);
        paginas++;
      } while (cursor && paginas < 100);
      expect(recorridos.map((a) => a.id)).toEqual(todos.map((a) => a.id));
      const ids = recorridos.map((a) => a.id);
      for (const nuevo of creados) expect(ids).toContain(nuevo.id);
      const fechas = recorridos.map((a) => Date.parse(a.createdAt));
      expect([...fechas].sort((x, y) => y - x)).toEqual(fechas);
    });

    it('400 con un cursor inventado, un límite fuera de rango o un parámetro desconocido', async () => {
      for (const consulta of [
        'cursor=nada',
        'limit=0',
        'limit=51',
        'includeInactive=quizas',
        'x=1',
      ]) {
        const r = await admin('get', `${USUARIOS}?${consulta}`).expect(400);
        esperarProblemDetails(r);
      }
    });
  });

  describe('DELETE (baja lógica)', () => {
    it('da de baja: 204, la cuenta queda inactiva (no se borra) y deja de salir en la lista', async () => {
      const objetivo = await alta();
      await admin('delete', `${USUARIOS}/${objetivo.id}`).expect(204);

      const fila = await prisma.db.usuario.findUniqueOrThrow({ where: { id: objetivo.id } });
      expect(fila.activo).toBe(false);

      const activos = (await admin('get', `${USUARIOS}?limit=50`).expect(200)).body
        .items as Admin[];
      expect(activos.find((a) => a.id === objetivo.id)).toBeUndefined();
      const todos = (await admin('get', `${USUARIOS}?limit=50&includeInactive=true`).expect(200))
        .body.items as Admin[];
      expect(todos.find((a) => a.id === objetivo.id)).toMatchObject({
        id: objetivo.id,
        active: false,
      });

      const eventos = await auditoria(objetivo.id);
      expect(eventos.map((e) => [e.evento, e.resultado, e.actor_id])).toEqual([
        ['ADMINISTRADOR_CREADO', 'EXITO', idAdmin],
        ['ADMINISTRADOR_DADO_DE_BAJA', 'EXITO', idAdmin],
      ]);
    });

    it('revoca sus refresh tokens: no puede renovar la sesión ni volver a entrar', async () => {
      const objetivo = await alta();
      const sesion = await iniciarSesion(app, {
        id: objetivo.id,
        correo: objetivo.email,
        contrasena: objetivo.password,
      });
      await admin('delete', `${USUARIOS}/${objetivo.id}`).expect(204);

      const tokens = await prisma.db.token_refresco.findMany({
        where: { usuario_id: objetivo.id },
      });
      expect(tokens.length).toBeGreaterThanOrEqual(1);
      for (const t of tokens) {
        expect(t.fecha_revocacion).not.toBeNull();
        expect(t.motivo_revocacion).toBe('USUARIO_INACTIVO');
      }
      const renovacion = await http()
        .post(`${AUTH}/refresh`)
        .send({ refresh_token: sesion.refresh_token })
        .expect(401);
      esperarProblemDetails(renovacion);
      await login(objetivo.email, objetivo.password).expect(401);
    });

    it('idempotente: repetir la baja responde 204 igual (y se audita una sola vez)', async () => {
      const objetivo = await alta();
      await admin('delete', `${USUARIOS}/${objetivo.id}`).expect(204);
      await admin('delete', `${USUARIOS}/${objetivo.id}`).expect(204);
      const bajas = (await auditoria(objetivo.id)).filter(
        (e) => e.evento === 'ADMINISTRADOR_DADO_DE_BAJA',
      );
      expect(bajas).toHaveLength(1);
    });

    it('409 si es la propia cuenta, y la cuenta sigue activa', async () => {
      const yo = await alta();
      const r = await http()
        .delete(`${USUARIOS}/${yo.id}`)
        .set('Authorization', `Bearer ${await tokenDe(yo)}`)
        .expect(409);
      esperarProblemDetails(r);
      expect(r.body.detail).toMatch(/your own account/);
      expect((await prisma.db.usuario.findUniqueOrThrow({ where: { id: yo.id } })).activo).toBe(
        true,
      );
      const eventos = await auditoria(yo.id);
      expect(eventos.at(-1)).toMatchObject({
        evento: 'ADMINISTRADOR_DADO_DE_BAJA',
        resultado: 'FALLO',
        motivo: 'PROPIA_CUENTA',
        actor_id: yo.id,
      });
    });

    it('404 si no existe, si es un cliente o si no es un uuid (400)', async () => {
      const cliente = await crearUsuario(app);
      for (const id of [randomUUID(), cliente.id]) {
        const r = await admin('delete', `${USUARIOS}/${id}`).expect(404);
        esperarProblemDetails(r);
        expect(r.body.detail).toBe(`Administrator ${id} was not found`);
      }
      expect(
        (await prisma.db.usuario.findUniqueOrThrow({ where: { id: cliente.id } })).activo,
      ).toBe(true);
      const mal = await admin('delete', `${USUARIOS}/no-es-un-uuid`).expect(400);
      esperarProblemDetails(mal);
      expect(mal.body.invalidParams).toEqual([{ name: 'id', reason: 'must be a UUID' }]);
    });

    it('dos administradores que se dan de baja a la vez no dejan al sistema sin ninguno', async () => {
      const a = await alta();
      const b = await alta();
      const [ta, tb] = [await tokenDe(a), await tokenDe(b)];
      const borrar = (token: string, id: string) =>
        http().delete(`${USUARIOS}/${id}`).set('Authorization', `Bearer ${token}`);
      const antes = await administradoresActivos();
      const respuestas = await Promise.all([borrar(ta, b.id), borrar(tb, a.id)]);
      // Nunca un 500 ni un bloqueo: cada baja o se hace (204) o la rechaza la regla (409)
      for (const r of respuestas) expect([204, 409]).toContain(r.status);
      const despues = await administradoresActivos();
      expect(despues).toBeGreaterThanOrEqual(1);
      expect(despues).toBeLessThan(antes + 1);
    });
  });

  describe('último administrador activo', () => {
    it('409: no se puede dar de baja al único administrador que queda', async () => {
      const otrosAdmins = await prisma.db.usuario.count({
        where: {
          activo: true,
          usuario_rol: { some: { activo: true, rol: { codigo: 'administrador' } } },
          NOT: { correo: { endsWith: `@${DOMINIO_PRUEBAS}` } },
        },
      });
      if (otrosAdmins > 0) {
        // Con un administrador real en la base (semilla) la regla no se puede aislar sin tocarlo.
        // En CI no hay ninguno (la semilla va sin hash_admin): ahí siempre corre.
        // eslint-disable-next-line no-console -- el aviso es para quien corre las pruebas
        console.warn(
          `Prueba omitida: hay ${otrosAdmins} administrador(es) activo(s) fuera de las pruebas`,
        );
        return;
      }
      // Solo queda activo el objetivo: los demás administradores de la prueba se dan de baja en
      // la base; el token de uno de ellos sigue vigente (el access token no se revoca).
      const objetivo = await alta();
      await prisma.db.usuario.updateMany({
        where: {
          id: { not: objetivo.id },
          correo: { endsWith: `@${DOMINIO_PRUEBAS}` },
          usuario_rol: { some: { activo: true, rol: { codigo: 'administrador' } } },
        },
        data: { activo: false },
      });
      const r = await admin('delete', `${USUARIOS}/${objetivo.id}`).expect(409);
      esperarProblemDetails(r);
      expect(r.body.detail).toMatch(/last active administrator/);
      expect(
        (await prisma.db.usuario.findUniqueOrThrow({ where: { id: objetivo.id } })).activo,
      ).toBe(true);
      expect((await auditoria(objetivo.id)).at(-1)).toMatchObject({
        resultado: 'FALLO',
        motivo: 'ULTIMO_ADMINISTRADOR',
        actor_id: idAdmin,
      });
      // Un token forjado con la firma del servicio no cambia la regla
      const falso = await app
        .get(TokensService)
        .emitir({ sub: randomUUID(), scopes: ['flights:admin'] });
      await http()
        .delete(`${USUARIOS}/${objetivo.id}`)
        .set('Authorization', `Bearer ${falso.token}`)
        .expect(409);
    });
  });
});
