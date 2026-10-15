import { NestExpressApplication } from '@nestjs/platform-express';
import { decodeProtectedHeader } from 'jose';
import * as request from 'supertest';
import { parDePrueba } from './utils/claves';
import { crearApp, escuchar } from './utils/crear-app';
import { crearUsuario, desactivarDatosDePrueba, iniciarSesion } from './utils/cuentas';
import { crearVerificador } from './utils/verificador';

/**
 * Rotación con las dos ranuras: el servicio "viejo" firma con A; el "nuevo" firma con B y deja
 * la pública de A como anterior; el "final" ya no tiene A. Un token firmado con A sigue
 * verificando mientras A está en el JWKS, y deja de verificar cuando se quita.
 */
describe('Rotación de claves', () => {
  const a = parDePrueba();
  const b = parDePrueba();
  let viejo: NestExpressApplication;
  let nuevo: NestExpressApplication;
  let final: NestExpressApplication;
  let urlNuevo: string;
  let urlFinal: string;
  let tokenViejo: string;
  let kidA: string;

  beforeAll(async () => {
    viejo = await crearApp({ claves: { firma: a.privada } });
    nuevo = await crearApp({ claves: { firma: b.privada, anterior: a.publica } });
    final = await crearApp({ claves: { firma: b.privada } });
    urlNuevo = await escuchar(nuevo);
    urlFinal = await escuchar(final);

    const usuario = await crearUsuario(viejo);
    tokenViejo = (await iniciarSesion(viejo, usuario)).access_token;
    kidA = decodeProtectedHeader(tokenViejo).kid ?? '';
  });

  afterAll(async () => {
    await desactivarDatosDePrueba(viejo);
    await Promise.all([viejo.close(), nuevo.close(), final.close()]);
  });

  it('durante la rotación el JWKS publica la clave nueva y la anterior', async () => {
    const { body } = await request(nuevo.getHttpServer()).get('/.well-known/jwks.json').expect(200);
    expect(body.keys).toHaveLength(2);
    expect(body.keys.map((k: { kid: string }) => k.kid)).toContain(kidA);
  });

  it('un token firmado antes de rotar sigue verificando con la clave anterior', async () => {
    await expect(crearVerificador(urlNuevo)(tokenViejo)).resolves.toBeDefined();
    await request(nuevo.getHttpServer())
      .get('/identity/v1/auth/me')
      .set('Authorization', `Bearer ${tokenViejo}`)
      .expect(200);
  });

  it('los tokens nuevos se firman con la clave nueva, no con la anterior', async () => {
    const usuario = await crearUsuario(nuevo);
    const { access_token } = await iniciarSesion(nuevo, usuario);
    const kid = decodeProtectedHeader(access_token).kid;
    expect(kid).not.toBe(kidA);
    await expect(crearVerificador(urlNuevo)(access_token)).resolves.toBeDefined();
    await expect(crearVerificador(urlFinal)(access_token)).resolves.toBeDefined();
  });

  it('sin la clave anterior en el JWKS, el token viejo ya no verifica', async () => {
    const { body } = await request(final.getHttpServer()).get('/.well-known/jwks.json').expect(200);
    expect(body.keys.map((k: { kid: string }) => k.kid)).not.toContain(kidA);

    await expect(crearVerificador(urlFinal)(tokenViejo)).rejects.toThrow(
      /no applicable key found in the JSON Web Key Set/,
    );
    await request(final.getHttpServer())
      .get('/identity/v1/auth/me')
      .set('Authorization', `Bearer ${tokenViejo}`)
      .expect(401);
  });
});
