/**
 * Cambia el secreto de un cliente OAuth 2.0 sin cambiar su client_id e imprime el nuevo UNA sola
 * vez:
 *
 *   npm run cliente:rotar-secreto -- --client-id booking-prototipo
 *
 * En la imagen de Docker:
 *   node dist/cli/rotar-secreto-cliente.js --client-id booking-prototipo
 *
 * El secreto anterior deja de servir en el acto (ver rotarSecretoCliente). Corre quien tiene
 * acceso a la base (DATABASE_URL del entorno o del .env). El secreto no se guarda en ningún lado
 * (en la base queda su hash argon2id) ni va a un log.
 */
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { crearClientePrisma } from '../prisma/prisma.service';
import { RotacionInvalida, rotarSecretoCliente } from '../modules/oauth2/clientes/rotar-secreto';

async function principal(): Promise<void> {
  const { values } = parseArgs({
    options: { 'client-id': { type: 'string' } },
    strict: true,
  });
  const clientId = values['client-id'];
  if (!clientId) throw new RotacionInvalida('--client-id es obligatorio');

  if (!process.env.DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL (en el entorno o en .env)');

  const db = crearClientePrisma(url);
  try {
    const rotado = await rotarSecretoCliente(db, clientId);
    console.log('Secreto cambiado. Guárdalo ahora: no se vuelve a mostrar.');
    console.log('El secreto anterior ya no sirve.');
    console.log(`client_id:     ${rotado.clientId}`);
    console.log(`client_secret: ${rotado.secreto}`);
  } finally {
    await db.$disconnect();
  }
}

principal().catch((error: unknown) => {
  if (error instanceof RotacionInvalida) {
    console.error(error.message);
  } else {
    // Sin el mensaje completo: el de Prisma puede copiar los valores (el hash del secreto)
    console.error(`No se pudo cambiar el secreto: ${(error as Error).name ?? 'error'}`);
  }
  process.exit(1);
});
