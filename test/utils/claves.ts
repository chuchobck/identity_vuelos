import { generateKeyPairSync } from 'node:crypto';

/** `iss` y `aud` con los que corre el servicio en las pruebas (ver entorno-pruebas.ts). */
export const EMISOR_PRUEBAS = 'http://identity.e2e.quinde.example';
export const AUDIENCIA_PRUEBAS = 'quinde-vuelos-api';

/** Un par RSA nuevo, con la privada y la pública como las piden las variables (PEM en base64). */
export function parDePrueba(bits = 2048): { privada: string; publica: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: bits });
  const enBase64 = (pem: string | Buffer) => Buffer.from(pem).toString('base64');
  return {
    privada: enBase64(privateKey.export({ type: 'pkcs8', format: 'pem' })),
    publica: enBase64(publicKey.export({ type: 'spki', format: 'pem' })),
  };
}

/** El PEM de una variable (base64) como texto. */
export function pemDe(base64: string): string {
  return Buffer.from(base64, 'base64').toString('utf8');
}
