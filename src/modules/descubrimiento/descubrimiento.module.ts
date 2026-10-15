import { Module } from '@nestjs/common';
import { DescubrimientoController } from './descubrimiento.controller';

@Module({ controllers: [DescubrimientoController] })
export class DescubrimientoModule {}
