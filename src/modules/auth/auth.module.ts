import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ScopesGuard } from '../../common/guards/scopes.guard';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { ContrasenaService } from './seguridad/contrasena.service';

/**
 * Cuentas de personas: registro, login, refresh, logout y perfil. También registra los guards
 * globales de autenticación; el orden de los APP_GUARD es el de registro:
 *
 *   1. GuardLimitePeticiones (CommonModule, que AppModule importa antes que este módulo)
 *   2. JwtAuthGuard: token válido de una persona salvo en rutas @Publico()
 *   3. ScopesGuard: los scopes que pide @Scopes(...) (hoy, flights:admin en /admin/users)
 */
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthRepository,
    ContrasenaService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: ScopesGuard },
  ],
  exports: [ContrasenaService, AuthRepository],
})
export class AuthModule {}
