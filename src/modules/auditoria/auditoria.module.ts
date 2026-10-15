import { Global, Module } from '@nestjs/common';
import { AuditoriaRepository } from './auditoria.repository';
import { AuditoriaSeguridad } from './auditoria.service';

/** Global: auth y oauth2 registran sus eventos de seguridad. */
@Global()
@Module({
  providers: [AuditoriaSeguridad, AuditoriaRepository],
  exports: [AuditoriaSeguridad],
})
export class AuditoriaModule {}
