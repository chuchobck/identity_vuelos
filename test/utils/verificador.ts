import { createRemoteJWKSet, JWTPayload, jwtVerify, ProtectedHeaderParameters } from 'jose';
import { AUDIENCIA_PRUEBAS, EMISOR_PRUEBAS } from './claves';

/**
 * Un consumidor externo de los tokens, como será el core en la fase 4b: NO usa el código del
 * servicio (ni TokensService ni ClavesService), solo `jose` y el JWKS publicado por HTTP.
 * Si el servicio firma algo que un consumidor no puede validar, esto lo detecta.
 *
 *   const verificar = crearVerificador(urlBase);
 *   const { payload } = await verificar(token);
 */
export function crearVerificador(
  urlBase: string,
  esperado: { emisor?: string; audiencia?: string } = {},
): (token: string) => Promise<{ payload: JWTPayload; protectedHeader: ProtectedHeaderParameters }> {
  const jwks = createRemoteJWKSet(new URL(`${urlBase}/.well-known/jwks.json`), {
    // Sin caché entre pruebas de rotación: cada verificador baja el JWKS vigente
    cooldownDuration: 0,
  });
  return (token) =>
    jwtVerify(token, jwks, {
      algorithms: ['RS256'],
      typ: 'at+jwt',
      issuer: esperado.emisor ?? EMISOR_PRUEBAS,
      audience: esperado.audiencia ?? AUDIENCIA_PRUEBAS,
      requiredClaims: ['exp', 'iat', 'jti', 'sub'],
    });
}
