import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService, TransaccionIdentidad } from '../../prisma/prisma.service';

/** Único punto del módulo que usa Prisma. La tabla es de solo inserción. */
@Injectable()
export class AuditoriaRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Con `tx`, dentro de esa transacción; sin ella, en una propia. */
  async insertar(
    fila: Prisma.auditoria_seguridadUncheckedCreateInput,
    tx?: TransaccionIdentidad,
  ): Promise<void> {
    await (tx ?? this.prisma.db).auditoria_seguridad.create({ data: fila, select: { id: true } });
  }
}
