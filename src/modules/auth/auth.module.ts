import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { ContrasenaService } from './seguridad/contrasena.service';

/**
 * Cuentas de personas: registro, login, refresh, logout y perfil. También registra el guard
 * global de autenticación; el orden de los APP_GUARD es el de registro de los módulos:
 *
 *   1. GuardLimitePeticiones (CommonModule, que AppModule importa antes que este módulo)
 *   2. JwtAuthGuard: token válido de una persona salvo en rutas @Publico()
 */
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthRepository,
    ContrasenaService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [ContrasenaService],
})
export class AuthModule {}
