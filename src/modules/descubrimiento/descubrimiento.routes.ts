import { RequestMethod } from '@nestjs/common';
import { RouteInfo } from '@nestjs/common/interfaces';
import { Routes } from '@nestjs/core';
import { DescubrimientoModule } from './descubrimiento.module';

export const descubrimientoRoutes: Routes = [{ path: '.well-known', module: DescubrimientoModule }];

/** Van en la raíz: el descubrimiento las busca en `{issuer}/.well-known/...`. */
export const descubrimientoEnLaRaiz: RouteInfo[] = [
  { path: '.well-known/jwks.json', method: RequestMethod.GET },
];
