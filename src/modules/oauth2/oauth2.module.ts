import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ClientesRepository } from './clientes/clientes.repository';
import { LimitePorCliente } from './limite-por-cliente';
import { OAuth2Controller } from './oauth2.controller';
import { OAuth2Service } from './oauth2.service';

/** /oauth2/token (client_credentials). Usa el ContrasenaService de auth para los secretos. */
@Module({
  imports: [AuthModule],
  controllers: [OAuth2Controller],
  providers: [OAuth2Service, ClientesRepository, LimitePorCliente],
})
export class OAuth2Module {}
