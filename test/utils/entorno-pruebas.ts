import { AUDIENCIA_PRUEBAS, EMISOR_PRUEBAS, parDePrueba } from './claves';

/**
 * Corre antes de cada archivo de pruebas (setupFiles de jest-e2e.json), antes de que se importe
 * AppModule: ConfigModule valida el entorno al importarse y process.env gana sobre el .env.
 *
 * Las claves de firma son efímeras: se generan para cada archivo y no dependen del .env. La
 * base sí sale del .env (o de DATABASE_URL en CI): las pruebas necesitan PostgreSQL arriba.
 */
const par = parDePrueba();
process.env.NODE_ENV = 'test';
process.env.PORT ??= '3001';
process.env.JWT_ISSUER = EMISOR_PRUEBAS;
process.env.JWT_AUDIENCE = AUDIENCIA_PRUEBAS;
process.env.JWT_SIGNING_KEY = par.privada;
process.env.JWT_PREVIOUS_PUBLIC_KEY = '';
// Pública de la clave que firma, para las pruebas que arman un ataque con ella (HS256)
process.env.PRUEBAS_JWT_PUBLIC_KEY = par.publica;
// Un solo origen de navegador, el de la prueba de CORS
process.env.CORS_ORIGINS = 'https://app.e2e.quinde.example';
// X-Forwarded-For desde 127.0.0.1: las pruebas simulan clientes con IP distintas
process.env.TRUST_PROXY = 'loopback';
// Sin puerto de métricas: varias apps de prueba conviven; la prueba de métricas abre el suyo
process.env.METRICS_PORT = '0';
