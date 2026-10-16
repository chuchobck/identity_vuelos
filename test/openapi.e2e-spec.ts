import { NestExpressApplication } from '@nestjs/platform-express';
import { readFileSync } from 'node:fs';
import * as request from 'supertest';
import { ARCHIVO_OPENAPI, serializarOpenApi } from '../src/cli/exportar-openapi';
import { crearDocumentoOpenApi } from '../src/config/swagger';
import { crearApp } from './utils/crear-app';

/**
 * contracts/identity-openapi.json tiene que ser exactamente el documento que genera el código:
 * si alguien cambia un controller o un DTO y no corre `npm run openapi:export`, esto falla.
 */
describe('Contrato OpenAPI versionado', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await crearApp();
  });

  afterAll(() => app.close());

  it('contracts/identity-openapi.json está al día (si no: npm run openapi:export)', () => {
    const versionado = readFileSync(ARCHIVO_OPENAPI, 'utf8');
    expect(versionado).toBe(serializarOpenApi(crearDocumentoOpenApi(app)));
  });

  it('es el mismo documento que sirve /api/docs-json', async () => {
    const { body } = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    expect(body).toEqual(JSON.parse(readFileSync(ARCHIVO_OPENAPI, 'utf8')));
  });

  it('documenta las rutas del servicio y nada más', () => {
    const documento = JSON.parse(readFileSync(ARCHIVO_OPENAPI, 'utf8')) as {
      paths: Record<string, unknown>;
    };
    expect(Object.keys(documento.paths).sort()).toEqual([
      '/.well-known/jwks.json',
      '/.well-known/openid-configuration',
      '/identity/v1/admin/users',
      '/identity/v1/admin/users/{id}',
      '/identity/v1/auth/login',
      '/identity/v1/auth/logout',
      '/identity/v1/auth/me',
      '/identity/v1/auth/refresh',
      '/identity/v1/auth/register',
      '/identity/v1/health',
      '/identity/v1/health/ready',
      '/oauth2/token',
    ]);
  });

  it('/admin/users va con su etiqueta, el candado y sus 400, 401 y 403', () => {
    const documento = JSON.parse(readFileSync(ARCHIVO_OPENAPI, 'utf8')) as {
      paths: Record<string, Record<string, Operacion>>;
      tags: Array<{ name: string }>;
    };
    expect(documento.tags.map((etiqueta) => etiqueta.name)).toContain('Admin · Administradores');
    const operaciones = [
      documento.paths['/identity/v1/admin/users'].get,
      documento.paths['/identity/v1/admin/users'].post,
      documento.paths['/identity/v1/admin/users/{id}'].delete,
    ];
    for (const operacion of operaciones) {
      expect(operacion.tags).toEqual(['Admin · Administradores']);
      expect(operacion.security).toEqual([{ bearer: [] }]);
      expect(Object.keys(operacion.responses)).toEqual(
        expect.arrayContaining(['400', '401', '403']),
      );
      expect(operacion.responses['403'].description).toContain('flights:admin');
    }
  });
});

interface Operacion {
  tags: string[];
  security: unknown[];
  responses: Record<string, { description: string }>;
}
