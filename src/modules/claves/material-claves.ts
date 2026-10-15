import { calculateJwkThumbprint } from 'jose';
import { createPrivateKey, createPublicKey, KeyObject } from 'node:crypto';

/** Tamaño mínimo del módulo RSA. Con menos, la firma no se considera segura (NIST SP 800-57). */
export const BITS_MINIMOS_RSA = 2048;

/** Único algoritmo que el servicio firma y acepta. */
export const ALGORITMO_FIRMA = 'RS256';

/** Una clave pública RSA como la publica el JWKS (RFC 7517), sin parámetros privados. */
export interface JwkPublica {
  kty: 'RSA';
  n: string;
  e: string;
  kid: string;
  alg: typeof ALGORITMO_FIRMA;
  use: 'sig';
}

/** Por qué una variable no tiene una clave usable. El texto nombra la variable, nunca el valor. */
export class ClaveInvalidaError extends Error {
  constructor(variable: string, problema: string) {
    super(`${variable} ${problema}`);
    this.name = 'ClaveInvalidaError';
  }
}

const PEM = /^-----BEGIN [A-Z ]+-----\r?\n[\s\S]+\r?\n-----END [A-Z ]+-----\s*$/;
const BASE64 = /^[A-Za-z0-9+/=_-]+$/;

/**
 * El PEM que viene en base64 en una variable de entorno. Se pide base64 (una sola línea) y no
 * el PEM directo porque un valor de varias líneas se rompe con facilidad en un .env, en Docker
 * o en el panel de una nube.
 */
function pemDeBase64(variable: string, valor: string): string {
  if (valor.includes('-----BEGIN')) {
    throw new ClaveInvalidaError(
      variable,
      'debe ser el PEM codificado en base64 en una sola línea, no el PEM directo',
    );
  }
  const limpio = valor.replace(/\s+/g, '');
  if (limpio === '' || !BASE64.test(limpio)) {
    throw new ClaveInvalidaError(
      variable,
      'debe ser un PEM codificado en base64 en una sola línea (no el PEM directo)',
    );
  }
  const pem = Buffer.from(limpio, 'base64').toString('utf8');
  if (!PEM.test(pem)) {
    throw new ClaveInvalidaError(variable, 'no es un PEM en base64 (falta "-----BEGIN ...")');
  }
  return pem;
}

function exigirRsaSuficiente(variable: string, clave: KeyObject): void {
  // rsa-pss no sirve: RS256 es RSASSA-PKCS1-v1_5
  if (clave.asymmetricKeyType !== 'rsa') {
    throw new ClaveInvalidaError(variable, 'debe ser una clave RSA (no EC, Ed25519 ni RSA-PSS)');
  }
  const bits = clave.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < BITS_MINIMOS_RSA) {
    throw new ClaveInvalidaError(variable, `debe tener al menos ${BITS_MINIMOS_RSA} bits`);
  }
}

/** Clave privada RSA (PKCS#8 o PKCS#1) de al menos 2048 bits, desde su PEM en base64. */
export function leerClavePrivada(variable: string, valorBase64: string): KeyObject {
  const pem = pemDeBase64(variable, valorBase64);
  let clave: KeyObject;
  try {
    clave = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw new ClaveInvalidaError(variable, 'no es una clave privada PEM legible (PKCS#8 o PKCS#1)');
  }
  exigirRsaSuficiente(variable, clave);
  return clave;
}

/**
 * Clave pública RSA de al menos 2048 bits, desde su PEM en base64. Si llega una privada, se
 * rechaza: la ranura anterior solo verifica y no debe tener con qué firmar.
 */
export function leerClavePublica(variable: string, valorBase64: string): KeyObject {
  const pem = pemDeBase64(variable, valorBase64);
  if (/-----BEGIN (RSA |ENCRYPTED )?PRIVATE KEY-----/.test(pem)) {
    throw new ClaveInvalidaError(
      variable,
      'debe ser una clave PÚBLICA: la ranura anterior solo verifica (usa la pública del par)',
    );
  }
  let clave: KeyObject;
  try {
    clave = createPublicKey({ key: pem, format: 'pem' });
  } catch {
    throw new ClaveInvalidaError(variable, 'no es una clave pública PEM legible (SPKI o PKCS#1)');
  }
  exigirRsaSuficiente(variable, clave);
  return clave;
}

/**
 * La parte pública como JWK, con `kid` = huella SHA-256 de la clave (RFC 7638). El `kid` sale
 * de la clave misma: no hace falta otra variable y la misma clave da siempre el mismo `kid`.
 */
export async function jwkPublica(clave: KeyObject): Promise<JwkPublica> {
  const publica = clave.type === 'private' ? createPublicKey(clave) : clave;
  const { n, e } = publica.export({ format: 'jwk' });
  if (typeof n !== 'string' || typeof e !== 'string') {
    throw new Error('La clave no tiene los parámetros n y e de RSA');
  }
  const kid = await calculateJwkThumbprint({ kty: 'RSA', n, e }, 'sha256');
  return { kty: 'RSA', n, e, kid, alg: ALGORITMO_FIRMA, use: 'sig' };
}
