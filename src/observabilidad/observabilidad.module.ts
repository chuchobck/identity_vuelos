import { Global, Logger, Module, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server } from 'node:http';
import { VERSION_SERVICIO } from '../config/swagger';
import { Metricas, servidorMetricas } from './metricas';
import { Observabilidad } from './observabilidad.service';
import { Trazas } from './trazas';

/** `service.name` de identity (docs/OBSERVABILIDAD.md, sección 1). */
export const SERVICIO = 'quinde-identity';

/**
 * Trazas y métricas del estándar de Quinde (docs/OBSERVABILIDAD.md). Es global: el middleware
 * (configurarApp) y los services toman `Trazas`, `Metricas` y `Observabilidad` de aquí.
 *
 * - El SDK de trazas SIEMPRE arranca, aunque no se exporte nada; el exportador OTLP solo con
 *   OTEL_EXPORTER_OTLP_ENDPOINT. La petición nunca espera al recolector.
 * - Las métricas salen en METRICS_PORT, un puerto aparte que el ingress nunca expone
 *   (0 lo apaga). En el puerto público `/metrics` no existe.
 * - Identity es un servicio interno: continúa el `traceparent` que le manda el gateway
 *   (TRACE_TRUST_INCOMING=true por defecto).
 */
@Global()
@Module({
  providers: [
    {
      provide: Trazas,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const entorno = config.get<string>('NODE_ENV') ?? 'development';
        return new Trazas({
          servicio: config.get<string>('OTEL_SERVICE_NAME') ?? SERVICIO,
          version: VERSION_SERVICIO,
          entorno,
          endpointOtlp: config.get<string>('OTEL_EXPORTER_OTLP_ENDPOINT') || undefined,
          muestreo: Number(
            config.get('OTEL_TRACES_SAMPLER_ARG') ?? (entorno === 'production' ? 0.1 : 1),
          ),
          confiarEntrante: config.get<string>('TRACE_TRUST_INCOMING') !== 'false',
          esperaLoteMs: Number(config.get('OTEL_BSP_SCHEDULE_DELAY') ?? 2000),
        });
      },
    },
    {
      provide: Metricas,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Metricas({
          servicio: config.get<string>('OTEL_SERVICE_NAME') ?? SERVICIO,
          version: VERSION_SERVICIO,
          entorno: config.get<string>('NODE_ENV') ?? 'development',
        }),
    },
    Observabilidad,
  ],
  exports: [Trazas, Metricas, Observabilidad],
})
export class ObservabilidadModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ObservabilidadModule.name);
  private servidor?: Server;

  constructor(
    private readonly config: ConfigService,
    private readonly trazas: Trazas,
    private readonly metricas: Metricas,
  ) {}

  async onModuleInit(): Promise<void> {
    const puerto = Number(this.config.get('METRICS_PORT') ?? 9464);
    if (puerto === 0) return;
    const servidor = servidorMetricas(this.metricas);
    try {
      await new Promise<void>((listo, falla) => {
        servidor.once('error', falla);
        servidor.listen(puerto, listo);
      });
      this.servidor = servidor;
      this.logger.log(`Métricas en el puerto ${puerto} (solo GET /metrics)`);
    } catch (error) {
      // Un puerto ocupado no tumba el servicio: se avisa (solo el código) y sigue sin métricas
      this.logger.warn(
        `No se pudo abrir el puerto de métricas: ${(error as { code?: string }).code ?? 'error'}`,
      );
    }
  }

  async onApplicationShutdown(): Promise<void> {
    const servidor = this.servidor;
    if (servidor) {
      servidor.closeAllConnections();
      await new Promise<void>((listo) => servidor.close(() => listo()));
    }
    // Lo que quede en la cola sale, con tope de tiempo
    await this.trazas.cerrar();
  }
}
