import { Controller, Get } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as request from 'supertest';
import { Publico } from '../src/common/decorators/publico.decorator';
import { crearClientePrisma, PrismaService } from '../src/prisma/prisma.service';
import { crearApp } from './utils/crear-app';
import { LimitesReiniciables } from './utils/limites';
import { esperarProblemDetails } from './utils/problem-details';

const DETALLE_INTERNO = 'detalle interno que no debe salir';

/** Solo existe en esta prueba: un fallo que nadie previó. */
@Publico()
@Controller('prueba-errores')
class ErroresDePruebaController {
  @Get('interno')
  interno(): never {
    throw new Error(DETALLE_INTERNO);
  }
}

/**
 * Lo transversal: salud, errores ProblemDetails sin stack, X-Request-Id, helmet, CORS, tope
 * del cuerpo y tipo de contenido.
 */
describe('Transversal', () => {
  let app: NestExpressApplication;
  const logs: string[] = [];
  const limites = new LimitesReiniciables();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await crearApp({ limites, logs, controllers: [ErroresDePruebaController] });
  });

  beforeEach(() => limites.reiniciar());

  afterAll(() => app.close());

  describe('salud', () => {
    it('/health responde sin mirar la base y /health/ready mira la base', async () => {
      const vida = await http().get('/identity/v1/health').expect(200);
      expect(vida.body).toEqual({ status: 'UP', timestamp: expect.any(String) });

      const lista = await http().get('/identity/v1/health/ready').expect(200);
      expect(lista.body).toEqual({ status: 'UP', database: 'UP', timestamp: expect.any(String) });
    });

    it('con la base caída: /health sigue en 200 y /health/ready responde 503', async () => {
      const db = crearClientePrisma('postgresql://nadie:nada@127.0.0.1:1/nada?schema=identidad');
      // Los mismos `logs`: el Logger de Nest es global y si no, la app principal dejaría de escribir
      const sinBase = await crearApp({
        logs,
        reemplazos: [
          {
            proveedor: PrismaService,
            valor: { db, onModuleInit: () => undefined, onModuleDestroy: () => db.$disconnect() },
          },
        ],
      });
      try {
        await request(sinBase.getHttpServer()).get('/identity/v1/health').expect(200);
        const respuesta = await request(sinBase.getHttpServer()).get('/identity/v1/health/ready');
        expect(respuesta.status).toBe(503);
        esperarProblemDetails(respuesta);
      } finally {
        await sinBase.close();
      }
    });
  });

  describe('errores', () => {
    it('una ruta que no existe: 404 ProblemDetails con X-Request-Id', async () => {
      const respuesta = await http().get('/identity/v1/no-existe');
      expect(respuesta.status).toBe(404);
      esperarProblemDetails(respuesta);
      expect(respuesta.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('un fallo no previsto: 500 sin detalle ni stack; el stack queda en el log', async () => {
      const respuesta = await http().get('/identity/v1/prueba-errores/interno');
      expect(respuesta.status).toBe(500);
      esperarProblemDetails(respuesta);
      expect(respuesta.body.detail).toBeUndefined();
      expect(JSON.stringify(respuesta.body)).not.toContain(DETALLE_INTERNO);
      expect(JSON.stringify(respuesta.body)).not.toContain('at ');

      const linea = logs
        .map((l) => JSON.parse(l) as { level: string; stack?: string; requestId?: string })
        .find((l) => l.level === 'error' && l.stack?.includes(DETALLE_INTERNO));
      expect(linea?.requestId).toBe(respuesta.headers['x-request-id']);
    });

    it('JSON roto: 400; más de 100 kB: 413; otro Content-Type: 415', async () => {
      const roto = await http()
        .post('/identity/v1/auth/login')
        .set('Content-Type', 'application/json')
        .send('{"email":');
      expect(roto.status).toBe(400);
      expect(roto.body.detail).toBe('Malformed JSON body');

      const grande = await http()
        .post('/identity/v1/auth/login')
        .send({ email: 'a@b.ec', password: 'x'.repeat(110_000) });
      expect(grande.status).toBe(413);
      esperarProblemDetails(grande);

      const texto = await http()
        .post('/identity/v1/auth/login')
        .set('Content-Type', 'text/plain')
        .send('hola');
      expect(texto.status).toBe(415);
      esperarProblemDetails(texto);
    });
  });

  describe('X-Request-Id', () => {
    it('respeta uno válido y reemplaza uno inválido', async () => {
      const valido = await http().get('/identity/v1/health').set('X-Request-Id', 'traza-12345678');
      expect(valido.headers['x-request-id']).toBe('traza-12345678');

      const invalido = await http().get('/identity/v1/health').set('X-Request-Id', 'con espacios');
      expect(invalido.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('cabeceras de seguridad y CORS', () => {
    it('helmet: nosniff, CSP y sin X-Powered-By', async () => {
      const respuesta = await http().get('/identity/v1/health');
      expect(respuesta.headers['x-content-type-options']).toBe('nosniff');
      expect(respuesta.headers['content-security-policy']).toBeDefined();
      expect(respuesta.headers['x-powered-by']).toBeUndefined();
    });

    it('CORS solo para los orígenes de la lista (nunca *)', async () => {
      const permitido = await http()
        .get('/identity/v1/health')
        .set('Origin', 'https://app.e2e.quinde.example');
      expect(permitido.headers['access-control-allow-origin']).toBe(
        'https://app.e2e.quinde.example',
      );

      const ajeno = await http().get('/identity/v1/health').set('Origin', 'https://malo.example');
      expect(ajeno.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
