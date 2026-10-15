import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** Único punto del módulo que usa Prisma. La tabla es de solo inserción. */
@Injectable()
export class AuditoriaRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insertar(fila: Prisma.auditoria_seguridadUncheckedCreateInput): Promise<void> {
    await this.prisma.db.auditoria_seguridad.create({ data: fila, select: { id: true } });
  }
}
