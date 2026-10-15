import { RequestMethod } from '@nestjs/common';
import { RouteInfo } from '@nestjs/common/interfaces';
import { Routes } from '@nestjs/core';
import { OAuth2Module } from './oauth2.module';
import { RUTA_TOKEN } from './ruta-token';

export const oauth2Routes: Routes = [{ path: 'oauth2', module: OAuth2Module }];

export const oauth2EnLaRaiz: RouteInfo[] = [
  { path: RUTA_TOKEN.slice(1), method: RequestMethod.POST },
];
