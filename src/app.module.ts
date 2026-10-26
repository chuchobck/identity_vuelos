import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RouterModule } from '@nestjs/core';
import { CommonModule } from './common/common.module';
import { validarEntorno } from './config/entorno';
import { AuditoriaModule } from './modules/auditoria/auditoria.module';
import { AdministradoresModule } from './modules/auth/administradores/administradores.module';
import { AuthModule } from './modules/auth/auth.module';
import { ClavesModule } from './modules/claves/claves.module';
import { DescubrimientoModule } from './modules/descubrimiento/descubrimiento.module';
import { OAuth2Module } from './modules/oauth2/oauth2.module';
import { ObservabilidadModule } from './observabilidad/observabilidad.module';
import { SaludModule } from './modules/salud/salud.module';
import { PrismaModule } from './prisma/prisma.module';
import { rutas } from './routes/index.routes';

@Module({
  imports: [
    // Carga las variables de entorno y las valida; si falta una, el servicio no levanta
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validarEntorno,
    }),

    // CommonModule va primero: el límite de peticiones es el primer guard global.
    PrismaModule,
    ObservabilidadModule,
    CommonModule,
    SaludModule,
    ClavesModule,
    AuditoriaModule,
    AuthModule,
    AdministradoresModule,
    OAuth2Module,
    DescubrimientoModule,

    // Tabla de rutas: src/routes/index.routes.ts
    RouterModule.register(rutas),
  ],
})
export class AppModule {}
