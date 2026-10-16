import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

export const RUTA_SWAGGER = 'api/docs';
/** Versión del servicio (la de package.json). */
export const VERSION_SERVICIO = '0.2.0';
const TITULO = 'Quinde · Identity';

/** Nombre del esquema bearer de Swagger (el del botón Authorize). */
export const ESQUEMA_BEARER = 'bearer';

/** Etiquetas de Swagger, en el orden en que se muestran. */
export const ETIQUETAS = {
  auth: 'Auth',
  adminUsuarios: 'Admin · Administradores',
  oauth2: 'OAuth 2.0',
  descubrimiento: 'Descubrimiento',
  salud: 'Salud',
} as const;

const DESCRIPCIONES: Record<keyof typeof ETIQUETAS, string> = {
  auth: 'Cuentas de personas: registro, login, refresh con rotación, logout y perfil (la misma forma que /flights/v1/auth del core).',
  adminUsuarios:
    'Altas, lista y bajas de administradores (scope flights:admin, solo con el token de una persona): las mismas rutas, cuerpos y errores que /flights/v1/admin/users del core. DELETE da de baja (activo = false), no borra.',
  oauth2:
    'Acceso máquina a máquina (RFC 6749, grant client_credentials). Errores con el formato de RFC 6749, no ProblemDetails.',
  descubrimiento:
    'Claves públicas (JWKS) y metadatos para que un consumidor valide los tokens sin compartir secretos.',
  salud: 'Chequeo de vida y de disponibilidad.',
};

/**
 * El documento OpenAPI del servicio. Es determinista (no depende del entorno ni de la hora):
 * así se puede exportar a contracts/identity-openapi.json y comparar en una prueba.
 */
export function crearDocumentoOpenApi(app: INestApplication): OpenAPIObject {
  const constructor = new DocumentBuilder()
    .setTitle(TITULO)
    .setDescription(
      'Proveedor de identidad de Quinde: emite tokens de acceso JWT RS256 (RFC 9068) para ' +
        'personas y para clientes OAuth 2.0, y publica sus claves públicas en ' +
        '/.well-known/jwks.json.',
    )
    .setVersion(VERSION_SERVICIO)
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Pega el access_token de POST /identity/v1/auth/login (vence en 15 minutos)',
      },
      ESQUEMA_BEARER,
    );

  for (const [clave, nombre] of Object.entries(ETIQUETAS)) {
    constructor.addTag(nombre, DESCRIPCIONES[clave as keyof typeof ETIQUETAS]);
  }
  return SwaggerModule.createDocument(app, constructor.build());
}

/** Swagger UI en /api/docs y el OpenAPI en JSON en /api/docs-json. */
export function configurarSwagger(app: INestApplication): void {
  SwaggerModule.setup(RUTA_SWAGGER, app, crearDocumentoOpenApi(app), {
    customSiteTitle: TITULO,
    swaggerOptions: { persistAuthorization: true },
  });
}
