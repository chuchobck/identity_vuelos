import { Body, Controller, Headers, HttpCode, Post, VERSION_NEUTRAL } from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { LimiteEstricto } from '../../common/decorators/limite-peticiones.decorator';
import { Publico } from '../../common/decorators/publico.decorator';
import { ETIQUETAS } from '../../config/swagger';
import { SCOPES } from '../auth/scopes';
import { ErrorOAuthDto, TokenClienteRespuestaDto } from './dto/token-cliente.dto';
import { LIMITES_OAUTH2 } from './limite-por-cliente';
import { OAuth2Service } from './oauth2.service';

const errorOAuth = (status: number, descripcion: string) =>
  ApiResponse({
    status,
    description: descripcion,
    content: { 'application/json': { schema: { $ref: getSchemaPath(ErrorOAuthDto) } } },
  });

/**
 * /oauth2/token en la raíz: es el `tokenUrl` de OAuth2Security en el contrato del core. Recibe
 * un formulario (application/x-www-form-urlencoded) y responde los errores con el formato de
 * RFC 6749 (ver ErroresFilter). Toda respuesta lleva Cache-Control: no-store.
 */
@ApiTags(ETIQUETAS.oauth2)
@ApiExtraModels(ErrorOAuthDto)
@Publico()
@Controller({ version: VERSION_NEUTRAL })
export class OAuth2Controller {
  constructor(private readonly servicio: OAuth2Service) {}

  @Post('token')
  @HttpCode(200)
  @LimiteEstricto(LIMITES_OAUTH2.porIp.limite, LIMITES_OAUTH2.porIp.ventanaSegundos)
  @ApiOperation({
    summary: 'Token de acceso para un cliente (grant client_credentials)',
    description:
      'El cliente se autentica con Authorization: Basic (client_secret_basic) o con client_id y ' +
      'client_secret en el formulario (client_secret_post), no con los dos. Sin `scope` recibe ' +
      'los permitidos menos flights:admin y events:publish, que solo salen si están permitidos ' +
      'y se piden. No hay refresh_token: cuando el token vence (15 minutos) se pide otro. ' +
      'authorization_code no está implementado.',
  })
  @ApiConsumes('application/x-www-form-urlencoded')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['grant_type'],
      properties: {
        grant_type: { type: 'string', enum: ['client_credentials'] },
        scope: {
          type: 'string',
          description: `Separados por espacio; posibles: ${SCOPES.join(' ')}`,
          example: 'flights:read flights:hold',
        },
        client_id: { type: 'string', description: 'Solo con client_secret_post' },
        client_secret: { type: 'string', description: 'Solo con client_secret_post' },
      },
    },
  })
  @ApiOkResponse({ type: TokenClienteRespuestaDto })
  @errorOAuth(400, 'invalid_request, invalid_scope o unsupported_grant_type')
  @errorOAuth(401, 'invalid_client (con WWW-Authenticate: Basic)')
  @errorOAuth(
    429,
    `temporarily_unavailable: más de ${LIMITES_OAUTH2.porIp.limite} por IP o ` +
      `${LIMITES_OAUTH2.porCliente.limite} por cliente en un minuto (Retry-After)`,
  )
  token(
    @Body() cuerpo: Record<string, unknown>,
    @Headers('authorization') autorizacion?: string,
  ): Promise<TokenClienteRespuestaDto> {
    return this.servicio.emitirToken(cuerpo, autorizacion);
  }
}
