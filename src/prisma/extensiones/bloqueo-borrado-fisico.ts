import { Prisma } from '../../generated/prisma/client';

/**
 * Tablas que sí se pueden borrar físicamente. Ninguna por ahora: una cuenta o un cliente se
 * dan de baja con `activo = false`, un token de refresco se revoca (UPDATE) y la auditoría es
 * de solo inserción. `token_refresco` no está a propósito: un token rotado tiene que seguir en
 * la tabla hasta vencer, porque es la prueba de que una segunda llegada es una reutilización.
 * Cuando exista la tarea que purga los vencidos, se agrega aquí con su justificación.
 */
export const TABLAS_CON_BORRADO_FISICO: ReadonlySet<Prisma.ModelName> = new Set<Prisma.ModelName>(
  [],
);

export class BorradoFisicoProhibidoError extends Error {
  constructor(
    readonly modelo: string,
    readonly operacion: 'delete' | 'deleteMany',
  ) {
    super(
      `${operacion} sobre "${modelo}" está prohibido: usa la eliminación lógica (activo = false) o una revocación`,
    );
    this.name = 'BorradoFisicoProhibidoError';
  }
}

function exigirBorradoPermitido(modelo: string, operacion: 'delete' | 'deleteMany'): void {
  if (!TABLAS_CON_BORRADO_FISICO.has(modelo as Prisma.ModelName)) {
    throw new BorradoFisicoProhibidoError(modelo, operacion);
  }
}

/**
 * Corta `delete` y `deleteMany` antes de que lleguen a la base (como en el core). No cubre los
 * borrados anidados dentro de un `update` ni `$executeRaw`: en esos casos el freno es la
 * revisión de código y los `ON DELETE RESTRICT` del esquema.
 */
export const bloqueoBorradoFisico = Prisma.defineExtension({
  name: 'bloqueo-borrado-fisico',
  query: {
    $allModels: {
      delete({ model, args, query }) {
        exigirBorradoPermitido(model, 'delete');
        return query(args);
      },
      deleteMany({ model, args, query }) {
        exigirBorradoPermitido(model, 'deleteMany');
        return query(args);
      },
    },
  },
});
