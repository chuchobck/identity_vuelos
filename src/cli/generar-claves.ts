/**
 * Genera un par de claves RSA para firmar los tokens y lo imprime listo para el .env:
 *
 *   npm run keys:generate                 (2048 bits)
 *   npm run keys:generate -- --bits 3072
 *
 * Imprime JWT_SIGNING_KEY (la privada, PEM PKCS#8 en base64) y, comentada, la pública del mismo
 * par: es la que va en JWT_PREVIOUS_PUBLIC_KEY cuando este par deje de firmar. No escribe ningún
 * archivo: la salida va a la terminal y de ahí al gestor de secretos. Ver docs/DEPLOY.md.
 */
import { generateKeyPairSync } from 'node:crypto';
import { BITS_MINIMOS_RSA, jwkPublica } from '../modules/claves/material-claves';

const BITS_PERMITIDOS = [2048, 3072, 4096];

function leerBits(argumentos: string[]): number {
  const posicion = argumentos.indexOf('--bits');
  if (posicion === -1) return BITS_MINIMOS_RSA;
  const bits = Number(argumentos[posicion + 1]);
  if (!BITS_PERMITIDOS.includes(bits)) {
    throw new Error(`--bits debe ser uno de: ${BITS_PERMITIDOS.join(', ')}`);
  }
  return bits;
}

async function principal(): Promise<void> {
  const bits = leerBits(process.argv.slice(2));
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: bits });
  const privadaPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicaPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const { kid } = await jwkPublica(privateKey);

  const enBase64 = (pem: string) => Buffer.from(pem, 'utf8').toString('base64');
  console.log(`# Par RSA de ${bits} bits. kid: ${kid}`);
  console.log('# La privada firma: va solo en el gestor de secretos o en tu .env, nunca en git.');
  console.log(`JWT_SIGNING_KEY=${enBase64(privadaPem)}`);
  console.log('# La pública del mismo par: pásala a JWT_PREVIOUS_PUBLIC_KEY cuando este par deje');
  console.log(
    '# de firmar (rotación). Mientras firme, no se usa: el JWKS la calcula de la privada.',
  );
  console.log(`# JWT_PREVIOUS_PUBLIC_KEY=${enBase64(publicaPem)}`);
}

principal().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
