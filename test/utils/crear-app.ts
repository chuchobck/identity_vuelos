import { Type } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getStorageToken } from '@nestjs/throttler';
import { AppModule } from '../../src/app.module';
import { LoggerJson } from '../../src/common/logger/logger-json';
import { Reloj } from '../../src/common/reloj';
import { configurarApp } from '../../src/configurar-app';
import { ClavesService } from '../../src/modules/claves/claves.service';
import { LimitesReiniciables } from './limites';
import { RelojDePrueba } from './reloj';

export interface OpcionesCrearApp {
  /** Reemplaza el Reloj de la aplicación (por ejemplo, un RelojDePrueba que se adelanta). */
  reloj?: Reloj;
  /**
   * Contadores del límite de peticiones que la prueba puede reiniciar. Sin esto, el límite usa
   * el Reloj de la app (el de `reloj` si se pasa): una prueba de límites pasa un RelojDePrueba.
   */
  limites?: LimitesReiniciables;
  /**
   * Claves distintas de las del entorno (PEM en base64), para probar la rotación: la que firma
   * y, opcional, la pública anterior.
   */
  claves?: { firma: string; anterior?: string };
  /**
   * Junta cada línea de log (JSON) en este arreglo, con debug encendido. Sin esto, los logs se
   * apagan para no llenar la salida de Jest. Ojo: el Logger de Nest es global en el proceso (cada
   * archivo de pruebas es un proceso aparte para Jest): la última app creada decide adónde van.
   */
  logs?: string[];
  /** Controllers que solo existen en la prueba. */
  controllers?: Type[];
  /** Otros providers reemplazados (por ejemplo PrismaService por uno contra una base caída). */
  reemplazos?: Array<{ proveedor: unknown; valor: unknown }>;
}

/**
 * Levanta el servicio completo, con la misma configuración que `main.ts` y la base del `.env`
 * (o DATABASE_URL). Las pruebas e2e necesitan PostgreSQL arriba.
 */
export async function crearApp(opciones: OpcionesCrearApp = {}): Promise<NestExpressApplication> {
  let constructor = Test.createTestingModule({
    imports: [AppModule],
    controllers: opciones.controllers ?? [],
  });
  if (opciones.reloj) constructor = constructor.overrideProvider(Reloj).useValue(opciones.reloj);
  if (opciones.limites) {
    // Con el reloj de la prueba, o con uno quieto: el límite nunca depende del reloj de la máquina
    opciones.limites.usarReloj(opciones.reloj ?? new RelojDePrueba());
    constructor = constructor.overrideProvider(getStorageToken()).useValue(opciones.limites);
  }
  if (opciones.claves) {
    const { firma, anterior } = opciones.claves;
    constructor = constructor
      .overrideProvider(ClavesService)
      .useValue(await ClavesService.desdeValores(firma, anterior));
  }
  for (const { proveedor, valor } of opciones.reemplazos ?? []) {
    constructor = constructor.overrideProvider(proveedor).useValue(valor);
  }
  const modulo = await constructor.compile();
  const app = modulo.createNestApplication<NestExpressApplication>({ bufferLogs: false });

  const logger = opciones.logs
    ? new LoggerJson((linea) => opciones.logs?.push(linea), ['debug', 'log', 'warn', 'error'])
    : false;
  configurarApp(app, { logger });
  await app.init();
  return app;
}

/**
 * Pone el servicio a escuchar en un puerto libre y devuelve su URL base: el verificador
 * independiente (jose con createRemoteJWKSet) baja el JWKS por HTTP, como lo hará el core.
 */
export async function escuchar(app: NestExpressApplication): Promise<string> {
  await app.listen(0, '127.0.0.1');
  const direccion = app.getHttpServer().address() as { port: number };
  return `http://127.0.0.1:${direccion.port}`;
}
