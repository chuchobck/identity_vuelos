import { ApiProperty } from '@nestjs/swagger';

/** Respuesta de client_credentials (RFC 6749, sección 5.1): sin refresh_token (sección 4.4.3). */
export class TokenClienteRespuestaDto {
  @ApiProperty({ description: 'JWT de acceso RS256 (RFC 9068); va en Authorization: Bearer' })
  access_token!: string;

  @ApiProperty({ enum: ['Bearer'] })
  token_type!: 'Bearer';

  @ApiProperty({ example: 900, description: 'Segundos de vida del token de acceso' })
  expires_in!: number;

  @ApiProperty({
    example: 'flights:read flights:hold',
    description: 'Scopes concedidos, separados por espacio',
  })
  scope!: string;
}

/** Error de /oauth2/token (RFC 6749, sección 5.2). */
export class ErrorOAuthDto {
  @ApiProperty({
    enum: [
      'invalid_request',
      'invalid_client',
      'invalid_scope',
      'unsupported_grant_type',
      'temporarily_unavailable',
      'server_error',
    ],
  })
  error!: string;

  @ApiProperty({ example: 'Client authentication failed' })
  error_description!: string;
}
