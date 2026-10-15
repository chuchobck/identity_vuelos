import { ApiProperty } from '@nestjs/swagger';

/** Una clave pública del JWKS (RFC 7517): solo `n` y `e`, nunca parámetros privados. */
export class JwkDto {
  @ApiProperty({ enum: ['RSA'] })
  kty!: 'RSA';

  @ApiProperty({ description: 'Módulo RSA en base64url' })
  n!: string;

  @ApiProperty({ example: 'AQAB', description: 'Exponente público en base64url' })
  e!: string;

  @ApiProperty({
    example: 'VNokron1-miRBDmPzffdzlicNLAtQy1rirAbrUUnYVc',
    description: 'Huella SHA-256 de la clave (RFC 7638); va en la cabecera `kid` de cada token',
  })
  kid!: string;

  @ApiProperty({ enum: ['RS256'] })
  alg!: 'RS256';

  @ApiProperty({ enum: ['sig'] })
  use!: 'sig';
}

export class JwksDto {
  @ApiProperty({
    type: [JwkDto],
    description: 'La clave que firma hoy y, durante una rotación, la anterior',
  })
  keys!: JwkDto[];
}
