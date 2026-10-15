import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClavesService } from './claves.service';
import { TokensService } from './tokens.service';

/**
 * Claves de firma y tokens de acceso. Global: auth y oauth2 emiten tokens y el guard los
 * verifica. ClavesService se crea con una fábrica asíncrona porque el `kid` (la huella de la
 * clave, RFC 7638) se calcula con una función asíncrona de jose.
 */
@Global()
@Module({
  providers: [
    {
      provide: ClavesService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ClavesService.desdeEntorno(config),
    },
    TokensService,
  ],
  exports: [ClavesService, TokensService],
})
export class ClavesModule {}
