import 'reflect-metadata';
import { generateKeyPairSync } from 'node:crypto';
import { validarEntorno } from '../src/config/entorno';
import { parDePrueba } from './utils/claves';

const enBase64 = (pem: string | Buffer) => Buffer.from(pem).toString('base64');

/**
 * La validación del entorno al arrancar (sin levantar la app): si falta la clave o no sirve,
 * el servicio no arranca, y el mensaje nombra la variable pero nunca muestra su valor.
 */
describe('Validación del entorno', () => {
  const actual = parDePrueba();
  const anterior = parDePrueba();
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/identity_db?schema=identidad',
    PORT: '3001',
    NODE_ENV: 'development',
    JWT_ISSUER: 'http://localhost:3001',
    JWT_SIGNING_KEY: actual.privada,
  };

  /** El mensaje de error, o undefined si arranca. */
  const error = (cambios: Record<string, string | undefined>): string | undefined => {
    try {
      validarEntorno({ ...base, ...cambios });
      return undefined;
    } catch (e) {
      return (e as Error).message;
    }
  };

  it('arranca con una clave RSA de 2048 bits y, opcional, la pública anterior', () => {
    expect(error({})).toBeUndefined();
    expect(error({ JWT_PREVIOUS_PUBLIC_KEY: anterior.publica })).toBeUndefined();
    // Vacía cuenta como no definida (JWT_PREVIOUS_PUBLIC_KEY= en el .env)
    expect(error({ JWT_PREVIOUS_PUBLIC_KEY: '' })).toBeUndefined();
  });

  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  const rsa1024 = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey;
  const pemDirecto = Buffer.from(actual.privada, 'base64').toString('utf8');

  it.each([
    ['falta la clave', { JWT_SIGNING_KEY: undefined }, 'JWT_SIGNING_KEY es obligatoria'],
    [
      'clave EC',
      { JWT_SIGNING_KEY: enBase64(ec.export({ type: 'pkcs8', format: 'pem' })) },
      'JWT_SIGNING_KEY debe ser una clave RSA',
    ],
    [
      'RSA de 1024 bits',
      { JWT_SIGNING_KEY: enBase64(rsa1024.export({ type: 'pkcs8', format: 'pem' })) },
      'JWT_SIGNING_KEY debe tener al menos 2048 bits',
    ],
    ['el PEM directo, sin base64', { JWT_SIGNING_KEY: pemDirecto }, 'no el PEM directo'],
    [
      'una pública en la ranura que firma',
      { JWT_SIGNING_KEY: actual.publica },
      'JWT_SIGNING_KEY no es una clave privada',
    ],
    [
      'una privada en la ranura anterior',
      { JWT_PREVIOUS_PUBLIC_KEY: anterior.privada },
      'JWT_PREVIOUS_PUBLIC_KEY debe ser una clave PÚBLICA',
    ],
    [
      'la misma clave en las dos ranuras',
      { JWT_PREVIOUS_PUBLIC_KEY: actual.publica },
      'JWT_PREVIOUS_PUBLIC_KEY: es la pública de JWT_SIGNING_KEY',
    ],
    ['falta el emisor', { JWT_ISSUER: undefined }, 'JWT_ISSUER es obligatoria'],
    ['emisor con barra final', { JWT_ISSUER: 'http://localhost:3001/' }, 'sin ruta ni barra final'],
    [
      'emisor con ruta',
      { JWT_ISSUER: 'https://quinde.example/identity' },
      'sin ruta ni barra final',
    ],
    [
      'emisor http en producción',
      { JWT_ISSUER: 'http://identity.quinde.example', NODE_ENV: 'production' },
      'debe ser https en producción',
    ],
    ['CORS con *', { CORS_ORIGINS: '*' }, 'CORS_ORIGINS debe ser una lista'],
  ])('no arranca con %s', (_caso, cambios, esperado) => {
    const mensaje = error(cambios) ?? '';
    expect(mensaje).toContain(esperado);
    // Nunca el valor: ni la clave en base64 ni un pedazo del PEM
    for (const valor of Object.values(cambios)) {
      if (valor && valor.length > 20) expect(mensaje).not.toContain(valor.slice(0, 30));
    }
    expect(mensaje).not.toContain('-----BEGIN');
  });

  it('acepta un emisor http en producción solo si es localhost (contenedor local)', () => {
    expect(error({ NODE_ENV: 'production', JWT_ISSUER: 'http://localhost:3001' })).toBeUndefined();
    expect(
      error({ NODE_ENV: 'production', JWT_ISSUER: 'https://identity.quinde.example' }),
    ).toBeUndefined();
  });
});
