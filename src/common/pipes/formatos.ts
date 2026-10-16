import { ArgumentMetadata } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { CodigoError } from '../errores/codigo-error';
import { ErrorNegocio } from '../errores/error-negocio';

/** Lo de src/common/pipes/formatos.ts del core que usa este servicio. */
export function esUuid(valor: unknown): valor is string {
  return typeof valor === 'string' && isUUID(valor);
}

/** 400 VALIDATION_FAILED nombrando el parámetro de ruta o de query que falló. */
export function rechazarParametro(metadata: ArgumentMetadata, razon: string): never {
  const nombre = metadata.data ?? 'value';
  throw new ErrorNegocio(400, CodigoError.VALIDATION_FAILED, `${nombre}: ${razon}`, {
    invalidParams: [{ name: nombre, reason: razon }],
  });
}
