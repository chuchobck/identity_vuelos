import { plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  validateSync,
} from 'class-validator';
import { createPublicKey } from 'node:crypto';
import { leerClavePrivada, leerClavePublica } from '../modules/claves/material-claves';
import { esOrigenValido, listarOrigenes } from './origenes-cors';
import { parsearTrustProxy } from './proxy';

export const ENTORNOS = ['development', 'production', 'test'] as const;
export type Entorno = (typeof ENTORNOS)[number];

@ValidatorConstraint({ name: 'listaDeOrigenes' })
class ListaDeOrigenes implements ValidatorConstraintInterface {
  validate(valor: unknown): boolean {
    return typeof valor === 'string' && listarOrigenes(valor).every(esOrigenValido);
  }

  // No repite los valores: el mensaje nombra la variable, nunca su contenido.
  defaultMessage(): string {
    return (
      'CORS_ORIGINS debe ser una lista de orígenes separados por coma, como ' +
      'https://app.example.com (sin ruta, sin barra final y sin "*")'
    );
  }
}

@ValidatorConstraint({ name: 'trustProxyValido' })
class TrustProxyValido implements ValidatorConstraintInterface {
  validate(valor: unknown): boolean {
    return typeof valor === 'string' && parsearTrustProxy(valor) !== undefined;
  }

  defaultMessage(): string {
    return (
      'TRUST_PROXY debe ser false, un número de proxies (1, 2...) o una lista separada por coma ' +
      'de IP, CIDR, loopback, linklocal o uniquelocal; "true" no se acepta porque deja falsear la IP'
    );
  }
}

/** El problema de una clave (texto sin el valor) o undefined si sirve. */
function problemaDeClave(lector: () => unknown): string | undefined {
  try {
    lector();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : 'no es una clave válida';
  }
}

@ValidatorConstraint({ name: 'clavePrivadaRsa' })
class ClavePrivadaRsa implements ValidatorConstraintInterface {
  validate(valor: unknown, { property }: ValidationArguments): boolean {
    return (
      typeof valor === 'string' &&
      problemaDeClave(() => leerClavePrivada(property, valor)) === undefined
    );
  }

  defaultMessage({ value, property }: ValidationArguments): string {
    return problemaDeClave(() => leerClavePrivada(property, String(value))) ?? property;
  }
}

@ValidatorConstraint({ name: 'clavePublicaRsa' })
class ClavePublicaRsa implements ValidatorConstraintInterface {
  validate(valor: unknown, { property }: ValidationArguments): boolean {
    return (
      typeof valor === 'string' &&
      problemaDeClave(() => leerClavePublica(property, valor)) === undefined
    );
  }

  defaultMessage({ value, property }: ValidationArguments): string {
    return problemaDeClave(() => leerClavePublica(property, String(value))) ?? property;
  }
}

/** Hosts en los que se acepta un emisor http aun en producción (pruebas locales del contenedor). */
const HOSTS_LOCALES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** El problema del emisor (sin repetir el valor) o undefined si sirve. */
export function problemaDelEmisor(valor: string, entorno: unknown): string | undefined {
  let url: URL;
  try {
    url = new URL(valor);
  } catch {
    return 'debe ser una URL absoluta, como https://identity.quinde.example';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'debe ser http o https';
  if (url.username || url.password || url.search || url.hash) {
    return 'no puede llevar usuario, contraseña, query ni fragmento';
  }
  // Sin ruta y sin barra final: /.well-known y /oauth2/token cuelgan de la raíz, y el `iss`
  // se compara texto a texto (con y sin barra son emisores distintos para un verificador).
  if (url.pathname !== '/' || valor.endsWith('/')) {
    return 'debe ser solo el origen del servicio, sin ruta ni barra final';
  }
  if (entorno === 'production' && url.protocol !== 'https:' && !HOSTS_LOCALES.has(url.hostname)) {
    return 'debe ser https en producción';
  }
  return undefined;
}

@ValidatorConstraint({ name: 'emisorValido' })
class EmisorValido implements ValidatorConstraintInterface {
  validate(valor: unknown, { object }: ValidationArguments): boolean {
    const entorno = (object as { NODE_ENV?: unknown }).NODE_ENV;
    return typeof valor === 'string' && problemaDelEmisor(valor, entorno) === undefined;
  }

  defaultMessage({ value, object }: ValidationArguments): string {
    const entorno = (object as { NODE_ENV?: unknown }).NODE_ENV;
    return `JWT_ISSUER ${problemaDelEmisor(String(value), entorno) ?? 'no es válida'}`;
  }
}

/**
 * Variables de entorno que el servicio necesita para arrancar. Las obligatorias no tienen
 * valor por defecto: si falta una o tiene un formato inválido, el servicio no levanta. Las
 * opcionales (`@IsOptional`) llevan su valor por defecto documentado en `.env.example` y en
 * docs/DEPLOY.md. Un mensaje de error nombra la variable, nunca su valor.
 */
export class VariablesEntorno {
  // class-validator evalúa de abajo hacia arriba: lo obligatorio va pegado a la propiedad.
  @Matches(/^postgres(ql)?:\/\/\S+$/, {
    message: 'DATABASE_URL debe ser una URL de PostgreSQL (postgresql://...)',
  })
  @IsString({ message: 'DATABASE_URL es obligatoria' })
  DATABASE_URL!: string;

  @Min(1, { message: 'PORT debe estar entre 1 y 65535' })
  @Max(65535, { message: 'PORT debe estar entre 1 y 65535' })
  @IsInt({ message: 'PORT es obligatorio y debe ser un número entero' })
  PORT!: number;

  @IsIn(ENTORNOS, { message: `NODE_ENV es obligatorio y debe ser uno de: ${ENTORNOS.join(', ')}` })
  NODE_ENV!: Entorno;

  /**
   * `iss` de los tokens y base del descubrimiento: el origen público del servicio, sin ruta
   * (https://identity.quinde.example). El core lo compara texto a texto con el `iss` del token.
   */
  @Validate(EmisorValido)
  @IsString({ message: 'JWT_ISSUER es obligatoria' })
  JWT_ISSUER!: string;

  /** `aud` de los tokens. Sin valor: quinde-vuelos-api (lo que el core ya acepta). */
  @Matches(/^\S+$/, { message: 'JWT_AUDIENCE no puede tener espacios' })
  @MaxLength(200, { message: 'JWT_AUDIENCE admite hasta 200 caracteres' })
  @IsOptional()
  JWT_AUDIENCE?: string;

  /**
   * Clave privada RSA (2048 bits o más) que firma los tokens: el PEM en base64, en una línea.
   * Obligatoria: sin ella el servicio no arranca. Generar con `npm run keys:generate`. Nunca va
   * a git, a un log ni a la base.
   */
  @Validate(ClavePrivadaRsa)
  @IsString({ message: 'JWT_SIGNING_KEY es obligatoria' })
  JWT_SIGNING_KEY!: string;

  /**
   * Clave pública del par anterior (PEM en base64), solo para verificar los tokens firmados
   * antes de rotar. Opcional: se quita cuando ya vencieron (ver docs/DEPLOY.md, "Rotar claves").
   */
  @Validate(ClavePublicaRsa)
  @IsOptional()
  JWT_PREVIOUS_PUBLIC_KEY?: string;

  /** Orígenes que pueden llamar desde un navegador. Sin valor: ninguno. */
  @Validate(ListaDeOrigenes)
  @IsOptional()
  CORS_ORIGINS?: string;

  /** Proxies delante del servicio. Sin valor: ninguno. Ver src/config/proxy.ts. */
  @Validate(TrustProxyValido)
  @IsOptional()
  TRUST_PROXY?: string;

  /** Peticiones por IP y por ventana en todo el servicio. Sin valor: 100. */
  @Max(100_000, { message: 'RATE_LIMIT_MAX debe estar entre 1 y 100000' })
  @Min(1, { message: 'RATE_LIMIT_MAX debe estar entre 1 y 100000' })
  @IsInt({ message: 'RATE_LIMIT_MAX debe ser un número entero' })
  @IsOptional()
  RATE_LIMIT_MAX?: number;

  /** Duración de la ventana del límite, en segundos. Sin valor: 60. */
  @Max(86_400, { message: 'RATE_LIMIT_WINDOW_SECONDS debe estar entre 1 y 86400' })
  @Min(1, { message: 'RATE_LIMIT_WINDOW_SECONDS debe estar entre 1 y 86400' })
  @IsInt({ message: 'RATE_LIMIT_WINDOW_SECONDS debe ser un número entero' })
  @IsOptional()
  RATE_LIMIT_WINDOW_SECONDS?: number;
}

/** Se pasa a ConfigModule.forRoot({ validate }); corre una sola vez, al arrancar. */
export function validarEntorno(config: Record<string, unknown>): VariablesEntorno {
  // Una variable vacía (`JWT_PREVIOUS_PUBLIC_KEY=` en el .env) cuenta como no definida
  const definidas = Object.fromEntries(Object.entries(config).filter(([, valor]) => valor !== ''));
  const variables = plainToInstance(VariablesEntorno, definidas, {
    enableImplicitConversion: true,
  });
  const errores = validateSync(variables, { stopAtFirstError: true });

  const problemas = errores.map(
    (e) => `  - ${e.property}: ${Object.values(e.constraints ?? {}).join('; ')}`,
  );
  if (errores.length === 0 && mismaClaveEnLasDosRanuras(variables)) {
    problemas.push(
      '  - JWT_PREVIOUS_PUBLIC_KEY: es la pública de JWT_SIGNING_KEY; debe ser la del par anterior',
    );
  }
  if (problemas.length > 0) {
    throw new Error(`Variables de entorno inválidas o faltantes:\n${problemas.join('\n')}`);
  }
  return variables;
}

/** Un error de rotación: la "anterior" es la misma clave que firma. */
function mismaClaveEnLasDosRanuras(variables: VariablesEntorno): boolean {
  if (!variables.JWT_PREVIOUS_PUBLIC_KEY) return false;
  const actual = createPublicKey(leerClavePrivada('JWT_SIGNING_KEY', variables.JWT_SIGNING_KEY));
  const anterior = leerClavePublica('JWT_PREVIOUS_PUBLIC_KEY', variables.JWT_PREVIOUS_PUBLIC_KEY);
  return actual.equals(anterior);
}
