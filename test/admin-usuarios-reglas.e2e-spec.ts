import 'reflect-metadata';
import { ErrorNegocio } from '../src/common/errores/error-negocio';
import { Reloj } from '../src/common/reloj';
import { AuditoriaSeguridad } from '../src/modules/auditoria/auditoria.service';
import { AuthRepository } from '../src/modules/auth/auth.repository';
import {
  AdministradoresRepository,
  FilaAdministrador,
  ResultadoBaja,
} from '../src/modules/auth/administradores/administradores.repository';
import { AdministradoresService } from '../src/modules/auth/administradores/administradores.service';
import { ContrasenaService } from '../src/modules/auth/seguridad/contrasena.service';

// Reglas de las bajas y de la lista de administradores, sin la API ni la base (el runner solo
// corre test/*.e2e-spec.ts, de ahí el nombre). Es test/admin-usuarios-reglas.e2e-spec.ts del
// core, más la auditoría. La regla contra la base va en admin-usuarios.

const AHORA = new Date(Date.UTC(2026, 9, 16, 12, 0, 0));
const TX = { soy: 'la transacción' };

function servicio(opciones: { baja?: ResultadoBaja; filas?: FilaAdministrador[] } = {}) {
  const repositorio = {
    baja: jest.fn(
      async (_id: string, _yo: string, _ahora: Date, alDarDeBaja: (tx: unknown) => unknown) => {
        const resultado = opciones.baja ?? 'dado-de-baja';
        if (resultado === 'dado-de-baja') await alDarDeBaja(TX);
        return resultado;
      },
    ),
    listar: jest.fn(async () => opciones.filas ?? []),
  };
  const auth = {
    crearUsuario: jest.fn(
      async (
        id: string,
        correo: string,
        _hash: string,
        _rol: string,
        alCrear: (tx: unknown) => unknown,
      ) => {
        await alCrear(TX);
        return { id, correo };
      },
    ),
    idPorCorreo: jest.fn(async () => null),
  };
  const contrasenas = { hashear: jest.fn(async () => '$argon2id$hash') };
  const auditoria = { registrar: jest.fn(async () => undefined), registrarEn: jest.fn() };
  const instancia = new AdministradoresService(
    auth as unknown as AuthRepository,
    contrasenas as unknown as ContrasenaService,
    repositorio as unknown as AdministradoresRepository,
    auditoria as unknown as AuditoriaSeguridad,
    { ahora: () => AHORA } as Reloj,
  );
  return { instancia, repositorio, auth, contrasenas, auditoria };
}

const fila = (n: number): FilaAdministrador => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  correo: `a${n}@example.com`,
  activo: true,
  fechaCreacion: new Date(Date.UTC(2026, 0, 1, 0, 0, n)),
});

async function error(promesa: Promise<unknown>): Promise<ErrorNegocio> {
  try {
    await promesa;
  } catch (e) {
    return e as ErrorNegocio;
  }
  throw new Error('Se esperaba un error');
}

describe('baja de administradores: reglas del service', () => {
  const ID = '00000000-0000-4000-8000-0000000000aa';
  const YO = '00000000-0000-4000-8000-0000000000bb';

  it('la baja normal pasa los ids (y la hora del Reloj) al repository y no devuelve nada', async () => {
    const { instancia, repositorio } = servicio();
    await expect(instancia.darDeBaja(ID, YO)).resolves.toBeUndefined();
    expect(repositorio.baja).toHaveBeenCalledWith(ID, YO, AHORA, expect.any(Function));
  });

  it('la baja hecha se audita en su transacción: cuenta afectada y quién la pidió', async () => {
    const { instancia, auditoria } = servicio();
    await instancia.darDeBaja(ID, YO);
    expect(auditoria.registrarEn).toHaveBeenCalledWith(TX, {
      evento: 'ADMINISTRADOR_DADO_DE_BAJA',
      resultado: 'EXITO',
      usuarioId: ID,
      actorId: YO,
    });
    expect(auditoria.registrar).not.toHaveBeenCalled();
  });

  it('idempotente: repetirla sobre quien ya estaba de baja también termina bien (y no audita)', async () => {
    const { instancia, auditoria } = servicio({ baja: 'ya-estaba-de-baja' });
    await expect(instancia.darDeBaja(ID, YO)).resolves.toBeUndefined();
    expect(auditoria.registrarEn).not.toHaveBeenCalled();
    expect(auditoria.registrar).not.toHaveBeenCalled();
  });

  it('404 si no existe o no es administrador', async () => {
    const { instancia } = servicio({ baja: 'no-existe' });
    const e = await error(instancia.darDeBaja(ID, YO));
    expect(e.status).toBe(404);
    expect(e.message).toBe(`Administrator ${ID} was not found`);
  });

  it('409 si es la propia cuenta, con un mensaje claro (y queda el intento)', async () => {
    const { instancia, auditoria } = servicio({ baja: 'es-el-mismo' });
    const e = await error(instancia.darDeBaja(YO, YO));
    expect(e.status).toBe(409);
    expect(e.message).toMatch(/your own account/);
    expect(auditoria.registrar).toHaveBeenCalledWith({
      evento: 'ADMINISTRADOR_DADO_DE_BAJA',
      resultado: 'FALLO',
      motivo: 'PROPIA_CUENTA',
      usuarioId: YO,
      actorId: YO,
    });
  });

  it('409 si es el último administrador activo (y queda el intento)', async () => {
    const { instancia, auditoria } = servicio({ baja: 'es-el-ultimo' });
    const e = await error(instancia.darDeBaja(ID, YO));
    expect(e.status).toBe(409);
    expect(e.message).toMatch(/last active administrator/);
    expect(auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({ resultado: 'FALLO', motivo: 'ULTIMO_ADMINISTRADOR' }),
    );
  });
});

describe('alta y lista de administradores: service', () => {
  const YO = '00000000-0000-4000-8000-0000000000bb';
  const CLAVE = 'una frase larga de prueba';

  it('el alta fija el rol administrador en el servidor y guarda el hash, no la contraseña', async () => {
    const { instancia, auth, contrasenas } = servicio();
    await instancia.crear({ email: 'nuevo@example.com', password: CLAVE }, YO);
    expect(contrasenas.hashear).toHaveBeenCalledWith(CLAVE);
    expect(auth.crearUsuario).toHaveBeenCalledWith(
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      'nuevo@example.com',
      '$argon2id$hash',
      'administrador',
      expect.any(Function),
    );
  });

  it('el alta se audita en su transacción con el autor, sin contraseña, hash ni correo', async () => {
    const { instancia, auth, auditoria } = servicio();
    await instancia.crear({ email: 'nuevo@example.com', password: CLAVE }, YO);
    const id = auth.crearUsuario.mock.calls[0][0];
    expect(auditoria.registrarEn).toHaveBeenCalledWith(TX, {
      evento: 'ADMINISTRADOR_CREADO',
      resultado: 'EXITO',
      usuarioId: id,
      actorId: YO,
    });
    expect(JSON.stringify(auditoria.registrarEn.mock.calls)).not.toMatch(
      /una frase|argon2|nuevo@example/,
    );
  });

  it('pide limite + 1 filas y entrega nextCursor solo si sobra una', async () => {
    const tres = [fila(3), fila(2), fila(1)];
    const { instancia, repositorio } = servicio({ filas: tres });
    const pagina = await instancia.listar({ limit: 2 });
    expect(repositorio.listar).toHaveBeenCalledWith({
      incluirInactivos: false,
      despuesDe: undefined,
      limite: 2,
    });
    expect(pagina.filas).toHaveLength(2);
    expect(pagina.nextCursor).toBeDefined();

    const { instancia: ultima } = servicio({ filas: [fila(2), fila(1)] });
    expect((await ultima.listar({ limit: 2 })).nextCursor).toBeUndefined();
  });

  it('el cursor devuelto se lee de vuelta: creación e id de la última fila de la página', async () => {
    const { instancia, repositorio } = servicio({ filas: [fila(3), fila(2), fila(1)] });
    const { nextCursor } = await instancia.listar({ limit: 2 });
    await instancia.listar({ limit: 2, cursor: nextCursor, includeInactive: true });
    expect(repositorio.listar).toHaveBeenLastCalledWith({
      incluirInactivos: true,
      despuesDe: { creada: fila(2).fechaCreacion, id: fila(2).id },
      limite: 2,
    });
  });

  it.each([
    'no-base64!',
    Buffer.from('x|y').toString('base64url'),
    Buffer.from('a').toString('base64url'),
  ])('un cursor que no es de esta lista es 400 (%s)', async (cursor) => {
    const { instancia } = servicio();
    const e = await error(instancia.listar({ cursor }));
    expect(e.status).toBe(400);
  });
});
