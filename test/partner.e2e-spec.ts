import { NestExpressApplication } from '@nestjs/platform-express';
import { decodeJwt } from 'jose';
import * as request from 'supertest';
import { ClienteCreado } from '../src/modules/oauth2/clientes/alta-cliente';
import {
  RotacionInvalida,
  rotarSecretoCliente,
} from '../src/modules/oauth2/clientes/rotar-secreto';
import { PrismaService } from '../src/prisma/prisma.service';
import { crearApp, escuchar } from './utils/crear-app';
import {
  basic,
  crearClienteDePrueba,
  desactivarCliente,
  desactivarDatosDePrueba,
} from './utils/cuentas';
import { LimitesReiniciables } from './utils/limites';
import { esperarErrorOAuth } from './utils/problem-details';
import { crearVerificador } from './utils/verificador';

const TOKEN = '/oauth2/token';
const CC = { grant_type: 'client_credentials' };

/** Los scopes del comando de docs/PARTNER-BOOKING.md, en el orden de SCOPES. */
const SCOPES_BOOKING = [
  'flights:read',
  'flights:hold',
  'flights:book',
  'flights:cancel',
  'flights:webhooks',
];

/**
 * El cliente de Booking Prototipo (el partner del contrato v2, `PartnerOAuth2`). Se crea con los
 * mismos scopes y banderas que el comando de producción (`booking-prototipo`: ninguna bandera
 * --permitir-*), con un client_id de prueba para no tocar uno real.
 */
describe('Partner Booking Prototipo (PartnerOAuth2)', () => {
  let app: NestExpressApplication;
  let booking: ClienteCreado;
  let verificar: ReturnType<typeof crearVerificador>;
  const limites = new LimitesReiniciables();
  const http = () => request(app.getHttpServer());
  const pedir = (
    cuerpo: Record<string, string>,
    cliente: Pick<ClienteCreado, 'clientId'> & { secreto: string },
  ) =>
    http()
      .post(TOKEN)
      .set('Authorization', basic(cliente.clientId, cliente.secreto))
      .type('form')
      .send(cuerpo);

  beforeAll(async () => {
    app = await crearApp({ limites });
    verificar = crearVerificador(await escuchar(app));
    booking = await crearClienteDePrueba(app, { scopes: SCOPES_BOOKING.join(' ') });
  });

  beforeEach(() => limites.reiniciar());

  afterAll(async () => {
    await desactivarDatosDePrueba(app);
    await app.close();
  });

  it('el token trae client_id (así el core lo reconoce como partner) y exactamente sus scopes', async () => {
    const respuesta = await pedir(CC, booking).expect(200);
    expect(respuesta.body).toMatchObject({
      token_type: 'Bearer',
      expires_in: 900,
      scope: SCOPES_BOOKING.join(' '),
    });
    expect(respuesta.body.refresh_token).toBeUndefined();
    expect(respuesta.headers['cache-control']).toBe('no-store');

    // Lo valida un consumidor independiente, con el JWKS publicado
    const { payload } = await verificar(respuesta.body.access_token);
    expect(payload).toMatchObject({
      sub: booking.id,
      client_id: booking.clientId,
      scope: SCOPES_BOOKING.join(' '),
    });
    expect(payload.exp! - payload.iat!).toBe(900);
    expect(String(payload.scope).split(' ')).toEqual(SCOPES_BOOKING);
  });

  it('pedir un subconjunto lo recibe; ni con scope ni sin él trae events:publish, flights:admin ni flights:ops', async () => {
    const subconjunto = await pedir({ ...CC, scope: 'flights:read flights:book' }, booking).expect(
      200,
    );
    expect(subconjunto.body.scope).toBe('flights:read flights:book');
    for (const respuesta of [subconjunto, await pedir(CC, booking).expect(200)]) {
      const scopes = String(decodeJwt(respuesta.body.access_token).scope).split(' ');
      for (const ajeno of ['events:publish', 'flights:admin', 'flights:ops']) {
        expect(scopes).not.toContain(ajeno);
      }
    }
  });

  it.each(['events:publish', 'flights:admin', 'flights:ops', 'flights:read events:publish'])(
    'pedir %s da invalid_scope 400',
    async (scope) => {
      esperarErrorOAuth(await pedir({ ...CC, scope }, booking), 400, 'invalid_scope');
    },
  );

  describe('rotación del secreto (npm run cliente:rotar-secreto)', () => {
    it('el secreto nuevo sirve, el anterior no, y el client_id, el sub y los scopes no cambian', async () => {
      const cliente = await crearClienteDePrueba(app, { scopes: SCOPES_BOOKING.join(' ') });
      const antes = await pedir(CC, cliente).expect(200);

      const db = app.get(PrismaService).db;
      const rotado = await rotarSecretoCliente(db, cliente.clientId);
      expect(rotado.clientId).toBe(cliente.clientId);
      expect(rotado.secreto).not.toBe(cliente.secreto);

      esperarErrorOAuth(await pedir(CC, cliente), 401, 'invalid_client');
      const despues = await pedir(CC, {
        clientId: cliente.clientId,
        secreto: rotado.secreto,
      }).expect(200);
      expect(decodeJwt(despues.body.access_token)).toMatchObject({
        sub: decodeJwt(antes.body.access_token).sub,
        client_id: cliente.clientId,
        scope: SCOPES_BOOKING.join(' '),
      });

      // Solo el hash argon2id queda en la base, y la rotación deja su evento
      const fila = await db.cliente_oauth.findUniqueOrThrow({ where: { id: cliente.id } });
      expect(fila.hash_secreto).toMatch(/^\$argon2id\$/);
      expect(JSON.stringify(fila)).not.toContain(rotado.secreto);
      const eventos = await db.auditoria_seguridad.findMany({
        where: { cliente_id: cliente.id, evento: 'CLIENTE_SECRETO_ROTADO' },
      });
      expect(eventos).toHaveLength(1);
      expect(
        JSON.stringify(eventos, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v)),
      ).not.toContain(rotado.secreto);
    });

    it('un cliente desconocido o dado de baja no se rota', async () => {
      const db = app.get(PrismaService).db;
      const baja = await crearClienteDePrueba(app, { scopes: 'flights:read' });
      await desactivarCliente(app, baja);
      await expect(rotarSecretoCliente(db, baja.clientId)).rejects.toThrow(RotacionInvalida);
      await expect(rotarSecretoCliente(db, 'e2e-no-existe-jamas')).rejects.toThrow(
        RotacionInvalida,
      );
      // Y el secreto del dado de baja sigue sin servir
      esperarErrorOAuth(await pedir(CC, baja), 401, 'invalid_client');
    });
  });
});
