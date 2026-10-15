import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

/** Un cliente OAuth tal como lo necesita /oauth2/token. */
export interface ClienteOAuth {
  id: string;
  /** El client_id. */
  codigo: string;
  hashSecreto: string;
  scopesPermitidos: string[];
  activo: boolean;
}

/** Único punto del módulo que usa Prisma. Los clientes se crean con `npm run cliente:crear`. */
@Injectable()
export class ClientesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async buscarPorCodigo(codigo: string): Promise<ClienteOAuth | null> {
    const fila = await this.prisma.db.cliente_oauth.findUnique({
      where: { codigo },
      select: { id: true, codigo: true, hash_secreto: true, scopes_permitidos: true, activo: true },
    });
    if (!fila) return null;
    return {
      id: fila.id,
      codigo: fila.codigo,
      hashSecreto: fila.hash_secreto,
      scopesPermitidos: fila.scopes_permitidos,
      activo: fila.activo,
    };
  }
}
