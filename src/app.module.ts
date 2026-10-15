import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RouterModule } from '@nestjs/core';
import { CommonModule } from './common/common.module';
import { validarEntorno } from './config/entorno';
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
    CommonModule,
    SaludModule,

    // Tabla de rutas: src/routes/index.routes.ts
    RouterModule.register(rutas),
  ],
})
export class AppModule {}
