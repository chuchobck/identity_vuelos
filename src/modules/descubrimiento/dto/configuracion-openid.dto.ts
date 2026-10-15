import { ApiProperty } from '@nestjs/swagger';

/**
 * Metadatos mínimos del proveedor (OpenID Connect Discovery 1.0 y RFC 8414). Lo que un consumidor
 * necesita para validar tokens (issuer, jwks_uri) y lo que un cliente necesita para pedirlos.
 */
export class ConfiguracionOpenIdDto {
  @ApiProperty({ example: 'https://identity.quinde.example' })
  issuer!: string;

  @ApiProperty({ example: 'https://identity.quinde.example/.well-known/jwks.json' })
  jwks_uri!: string;

  @ApiProperty({ example: 'https://identity.quinde.example/oauth2/token' })
  token_endpoint!: string;

  @ApiProperty({ example: ['client_secret_basic', 'client_secret_post'] })
  token_endpoint_auth_methods_supported!: string[];

  @ApiProperty({ example: ['client_credentials'] })
  grant_types_supported!: string[];

  @ApiProperty({ example: ['flights:read', 'flights:hold'] })
  scopes_supported!: string[];

  @ApiProperty({
    example: ['RS256'],
    description: 'Este servicio no emite id_token: es el algoritmo de todo lo que firma',
  })
  id_token_signing_alg_values_supported!: string[];
}
