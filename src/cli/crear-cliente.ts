/**
 * Crea un cliente OAuth 2.0 (grant client_credentials) e imprime su secreto UNA sola vez:
 *
 *   npm run cliente:crear -- --nombre "Agencia Andina" --scopes "flights:read flights:hold"
 *   npm run cliente:crear -- --nombre "Batch catálogo" --scopes "flights:admin" --permitir-admin
 *   npm run cliente:crear -- --nombre "..." --scopes "..." --client-id agencia-andina
 *
 * No hay endpoint para crear clientes: solo esta herramienta, que corre quien tiene acceso a la
 * base (DATABASE_URL del entorno o del .env). En la imagen de Docker:
 *   node dist/cli/crear-cliente.js --nombre ... --scopes ...
 *
 * El secreto no se guarda en ningún lado (en la base queda su hash argon2id) ni va a un log:
 * se copia de la terminal al gestor de secretos del cliente. Si se pierde, se crea otro cliente.
 */
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { crearClientePrisma } from '../prisma/prisma.service';
import { AltaClienteInvalida, crearCliente } from '../modules/oauth2/clientes/alta-cliente';

async function principal(): Promise<void> {
  const { values } = parseArgs({
    options: {
      nombre: { type: 'string' },
      scopes: { type: 'string' },
      'client-id': { type: 'string' },
      'permitir-admin': { type: 'boolean', default: false },
    },
    strict: true,
  });

  if (!process.env.DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL (en el entorno o en .env)');

  const db = crearClientePrisma(url);
  try {
    const cliente = await crearCliente(db, {
      nombre: values.nombre ?? '',
      scopes: values.scopes ?? '',
      clientId: values['client-id'],
      permitirAdmin: values['permitir-admin'],
    });
    console.log('Cliente creado. Guarda el secreto ahora: no se vuelve a mostrar.');
    console.log(`client_id:     ${cliente.clientId}`);
    console.log(`client_secret: ${cliente.secreto}`);
    console.log(`scopes:        ${cliente.scopes.join(' ')}`);
    console.log(`sub (uuid):    ${cliente.id}`);
  } finally {
    await db.$disconnect();
  }
}

principal().catch((error: unknown) => {
  if (error instanceof AltaClienteInvalida) {
    console.error(error.message);
  } else if ((error as { code?: unknown }).code === 'P2002') {
    console.error('Ya existe un cliente con ese --client-id');
  } else {
    // Sin el mensaje completo: el de Prisma puede copiar los valores (el hash del secreto)
    console.error(`No se pudo crear el cliente: ${(error as Error).name ?? 'error'}`);
  }
  process.exit(1);
});
