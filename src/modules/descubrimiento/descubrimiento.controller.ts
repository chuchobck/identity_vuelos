import { Controller, Get, Header, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Publico } from '../../common/decorators/publico.decorator';
import { ETIQUETAS } from '../../config/swagger';
import { ClavesService } from '../claves/claves.service';
import { JwksDto } from './dto/jwks.dto';

/**
 * Cuánto puede guardar un consumidor el JWKS. Al rotar, la clave nueva tarda a lo sumo esto en
 * verse; por eso la anterior se deja publicada al menos 15 minutos (vida de un token) más esto.
 */
export const CACHE_DESCUBRIMIENTO = 'public, max-age=300';

/** En la raíz (`/.well-known/...`), sin /identity/v1: ahí los busca el descubrimiento. */
@ApiTags(ETIQUETAS.descubrimiento)
@Publico()
@Controller({ version: VERSION_NEUTRAL })
export class DescubrimientoController {
  constructor(private readonly claves: ClavesService) {}

  @Get('jwks.json')
  @Header('Cache-Control', CACHE_DESCUBRIMIENTO)
  @ApiOperation({
    summary: 'Claves públicas para verificar los tokens (JWKS)',
    description:
      'La clave actual y, durante una rotación, la anterior. Un consumidor elige la clave por el `kid` del token y acepta solo RS256.',
  })
  @ApiOkResponse({ type: JwksDto })
  jwks(): JwksDto {
    return this.claves.jwks();
  }
}
