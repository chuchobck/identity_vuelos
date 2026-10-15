import { Controller, Get, Header, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Publico } from '../../common/decorators/publico.decorator';
import { ETIQUETAS } from '../../config/swagger';
import { SCOPES } from '../auth/scopes';
import { ClavesService } from '../claves/claves.service';
import { ALGORITMO_FIRMA } from '../claves/material-claves';
import { TokensService } from '../claves/tokens.service';
import { GRANT_CLIENT_CREDENTIALS } from '../oauth2/peticion-token';
import { RUTA_TOKEN } from '../oauth2/ruta-token';
import { ConfiguracionOpenIdDto } from './dto/configuracion-openid.dto';
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
  constructor(
    private readonly claves: ClavesService,
    private readonly tokens: TokensService,
  ) {}

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

  @Get('openid-configuration')
  @Header('Cache-Control', CACHE_DESCUBRIMIENTO)
  @ApiOperation({
    summary: 'Metadatos del proveedor (descubrimiento)',
    description:
      'issuer, jwks_uri y token_endpoint salen de JWT_ISSUER. Solo client_credentials: el login de personas es POST /identity/v1/auth/login.',
  })
  @ApiOkResponse({ type: ConfiguracionOpenIdDto })
  configuracion(): ConfiguracionOpenIdDto {
    const emisor = this.tokens.emisor;
    return {
      issuer: emisor,
      jwks_uri: `${emisor}/.well-known/jwks.json`,
      token_endpoint: `${emisor}${RUTA_TOKEN}`,
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      grant_types_supported: [GRANT_CLIENT_CREDENTIALS],
      scopes_supported: [...SCOPES],
      id_token_signing_alg_values_supported: [ALGORITMO_FIRMA],
    };
  }
}
