import { RequestMethod } from '@nestjs/common';
import { RouteInfo } from '@nestjs/common/interfaces';
import { Routes } from '@nestjs/core';
import {
  descubrimientoEnLaRaiz,
  descubrimientoRoutes,
} from '../modules/descubrimiento/descubrimiento.routes';
import { administradoresRoutes } from '../modules/auth/administradores/administradores.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { oauth2EnLaRaiz, oauth2Routes } from '../modules/oauth2/oauth2.routes';
import { RUTA_TOKEN } from '../modules/oauth2/ruta-token';
import { saludRoutes } from '../modules/salud/salud.routes';

/** Prefijo global de las rutas propias del servicio: /identity/v1/... */
export const PREFIJO_GLOBAL = 'identity';

/** Versión por defecto de todo controller; una v2 se agrega con @Version('2'). */
export const VERSION_POR_DEFECTO = '1';

/**
 * Rutas que viven en la raíz, sin /identity/v1: su lugar lo fijan los estándares y el
 * contrato del core, no este servicio.
 *
 * - /.well-known/openid-configuration y /.well-known/jwks.json: el descubrimiento de OpenID
 *   (y RFC 8414) los busca en `{issuer}/.well-known/...`.
 * - /oauth2/token: el `tokenUrl` de OAuth2Security en el contrato del core (.../oauth2/token).
 *
 * Sus controllers llevan VERSION_NEUTRAL para que tampoco reciban el /v1.
 */
export const RUTAS_EN_LA_RAIZ: RouteInfo[] = [...descubrimientoEnLaRaiz, ...oauth2EnLaRaiz];

/**
 * Única tabla de rutas del servicio. Junta los *.routes.ts de cada módulo; los controllers
 * no llevan prefijo propio.
 */
export const rutas: Routes = [
  ...saludRoutes,
  ...authRoutes,
  ...administradoresRoutes,
  ...oauth2Routes,
  ...descubrimientoRoutes,
];

/**
 * Rutas cuyas respuestas no se guardan en ninguna caché: entregan tokens, datos de la cuenta o
 * la lista de administradores.
 */
export const RUTAS_SIN_CACHE = [
  `/${PREFIJO_GLOBAL}/v${VERSION_POR_DEFECTO}/auth/`,
  `/${PREFIJO_GLOBAL}/v${VERSION_POR_DEFECTO}/admin/`,
  RUTA_TOKEN,
];

/** Las rutas de RUTAS_EN_LA_RAIZ, en el formato de `setGlobalPrefix({ exclude })`. */
export const excluidasDelPrefijo = (): RouteInfo[] =>
  RUTAS_EN_LA_RAIZ.map(({ path, method }) => ({ path, method: method ?? RequestMethod.ALL }));
