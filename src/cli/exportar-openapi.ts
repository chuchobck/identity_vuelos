/**
 * Escribe el OpenAPI del servicio en contracts/identity-openapi.json:
 *
 *   npm run openapi:export
 *
 * El documento sale de los mismos decoradores que sirven /api/docs, sin base de datos ni
 * claves reales: la app se arma (no se inicia) con un entorno de relleno. Una prueba
 * (test/openapi.e2e-spec.ts) falla si el archivo versionado quedó desactualizado.
 */
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppModule } from '../app.module';
import { configurarApp } from '../configurar-app';
import { crearDocumentoOpenApi } from '../config/swagger';

export const ARCHIVO_OPENAPI = join(process.cwd(), 'contracts', 'identity-openapi.json');

/** El documento como texto estable: dos espacios y salto de línea final. */
export function serializarOpenApi(documento: object): string {
  return `${JSON.stringify(documento, null, 2)}\n`;
}

/**
 * Un entorno de relleno: el documento no depende de ninguna variable, pero la app no se arma
 * sin un entorno válido. La clave es efímera (se genera aquí y se descarta).
 */
function entornoDeRelleno(): void {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  Object.assign(process.env, {
    NODE_ENV: 'development',
    PORT: '3001',
    DATABASE_URL: 'postgresql://openapi:openapi@127.0.0.1:1/openapi?schema=identidad',
    JWT_ISSUER: 'http://localhost:3001',
    JWT_SIGNING_KEY: Buffer.from(pem).toString('base64'),
    JWT_PREVIOUS_PUBLIC_KEY: '',
  });
}

async function principal(): Promise<void> {
  entornoDeRelleno();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  configurarApp(app, { logger: false });
  const documento = crearDocumentoOpenApi(app);
  mkdirSync(dirname(ARCHIVO_OPENAPI), { recursive: true });
  writeFileSync(ARCHIVO_OPENAPI, serializarOpenApi(documento));
  await app.close();
  console.log(`OpenAPI escrito en ${ARCHIVO_OPENAPI}`);
}

if (require.main === module) {
  principal().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
