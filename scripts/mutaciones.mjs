#!/usr/bin/env node
// "Rompe a propósito lo que cada prueba cubre": aplica una mutación al código (aceptar alg none,
// quitar la comprobación de aud, dejar que un cliente reciba flights:admin, loguear un token...),
// corre la prueba que la debería detectar y exige que FALLE. Restaura el archivo siempre.
//
//   npm run test:mutaciones                 (todas; necesita PostgreSQL, como las pruebas)
//   npm run test:mutaciones -- alg-none     (solo las que contienen ese texto en el nombre)
//
// Una mutación cuyo texto ya no está en el código (alguien cambió esa línea) cuenta como fallo
// del script: hay que actualizarla aquí. No corre en CI: tarda unos minutos.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const TOKENS = 'src/modules/claves/tokens.service.ts';
const AUTH = 'src/modules/auth/auth.service.ts';
const OAUTH = 'src/modules/oauth2/oauth2.service.ts';

/** nombre, archivo, cambios [buscar, reemplazar], prueba y filtro (-t) que debe fallar. */
const MUTACIONES = [
  {
    nombre: 'alg-none: el servicio acepta un token sin firma',
    archivo: TOKENS,
    cambios: [
      [
        '    let payload: Record<string, unknown>;\n    try {',
        "    let payload: Record<string, unknown>;\n    const jose = require('jose');\n    if (jose.decodeProtectedHeader(token).alg === 'none') {\n      return { sub: String(jose.decodeJwt(token).sub), scopes: [], jti: 'x' };\n    }\n    try {",
      ],
    ],
    prueba: 'test/tokens.e2e-spec.ts',
    filtro: 'alg none',
  },
  {
    nombre: 'aud: el servicio no comprueba la audiencia',
    archivo: TOKENS,
    cambios: [['        audience: this.audiencia,\n', '']],
    prueba: 'test/tokens.e2e-spec.ts',
    filtro: 'aud ajeno',
  },
  {
    nombre: 'iss: el servicio no comprueba el emisor',
    archivo: TOKENS,
    cambios: [['        issuer: this.emisor,\n', '']],
    prueba: 'test/tokens.e2e-spec.ts',
    filtro: 'iss ajeno',
  },
  {
    nombre: 'typ: el servicio no exige at+jwt',
    archivo: TOKENS,
    cambios: [['        typ: TIPO_TOKEN_ACCESO,\n', '']],
    prueba: 'test/tokens.e2e-spec.ts',
    filtro: 'typ distinto',
  },
  {
    nombre: 'exp-obligatorio: un token sin exp pasa',
    archivo: TOKENS,
    cambios: [
      ["requiredClaims: ['exp', 'iat', 'jti', 'sub'],", "requiredClaims: ['iat', 'jti', 'sub'],"],
    ],
    prueba: 'test/tokens.e2e-spec.ts',
    filtro: 'sin exp',
  },
  {
    nombre: 'vencido: dos horas de tolerancia dejan pasar un token vencido',
    archivo: TOKENS,
    cambios: [
      [
        '        currentDate: this.reloj.ahora(),\n',
        "        currentDate: this.reloj.ahora(),\n        clockTolerance: '2 hours',\n",
      ],
    ],
    prueba: 'test/tokens.e2e-spec.ts',
    filtro: 'token vencido',
  },
  {
    nombre: 'hs256: confusión de algoritmo con la clave pública como secreto',
    archivo: TOKENS,
    cambios: [
      ['        algorithms: [ALGORITMO_FIRMA],', "        algorithms: [ALGORITMO_FIRMA, 'HS256'],"],
      [
        '    const clave = cabecera.kid ? this.claves.claveDeVerificacion(cabecera.kid) : undefined;',
        "    if (cabecera.alg === 'HS256') {\n      const publica = this.claves.claveDeVerificacion(cabecera.kid ?? '');\n      return new TextEncoder().encode(publica?.export({ type: 'spki', format: 'pem' }) as string) as never;\n    }\n    const clave = cabecera.kid ? this.claves.claveDeVerificacion(cabecera.kid) : undefined;",
      ],
    ],
    prueba: 'test/tokens.e2e-spec.ts',
    filtro: 'HS256',
  },
  {
    nombre: 'kid: un kid desconocido cae en la clave actual',
    archivo: TOKENS,
    cambios: [
      [
        '    if (!clave) throw new errors.JWKSNoMatchingKey();',
        '    if (!clave) return this.claves.claveDeVerificacion(this.claves.claveDeFirma().kid) as KeyObject;',
      ],
    ],
    prueba: 'test/tokens.e2e-spec.ts',
    filtro: 'kid desconocido aunque la firma sea de la clave real',
  },
  {
    nombre: 'rotación: la clave anterior no se publica ni verifica',
    archivo: 'src/modules/claves/claves.service.ts',
    cambios: [['    if (anterior && anterior.kid !== firma.kid) vigentes.push(anterior);\n', '']],
    prueba: 'test/rotacion.e2e-spec.ts',
    filtro: 'sigue verificando',
  },
  {
    nombre: 'admin-pedido: un cliente sin flights:admin permitido lo recibe si lo pide',
    archivo: OAUTH,
    cambios: [
      [
        '(scope) => !esScope(scope) || !permitidos.has(scope)',
        "(scope) => !esScope(scope) || (!permitidos.has(scope) && scope !== 'flights:admin')",
      ],
    ],
    prueba: 'test/oauth2.e2e-spec.ts',
    filtro: 'no lo tiene permitido',
  },
  {
    nombre: 'admin-implicito: un cliente recibe flights:admin sin pedirlo',
    archivo: OAUTH,
    cambios: [
      [
        '(scope) => scope !== SCOPE_ADMINISTRACION && permitidos.has(scope)',
        '(scope) => permitidos.has(scope)',
      ],
    ],
    prueba: 'test/oauth2.e2e-spec.ts',
    filtro: 'permitido pero no pedido',
  },
  {
    nombre: 'cliente-inactivo: un cliente dado de baja recibe token',
    archivo: OAUTH,
    cambios: [['    if (!valido || !cliente.activo) {', '    if (!valido) {']],
    prueba: 'test/oauth2.e2e-spec.ts',
    filtro: 'responden exactamente igual',
  },
  {
    nombre: 'refresh-cliente: client_credentials entrega refresh_token',
    archivo: OAUTH,
    cambios: [
      [
        "      token_type: 'Bearer',\n      expires_in: acceso.expiraEnSegundos,",
        "      token_type: 'Bearer',\n      refresh_token: 'no-deberia',\n      expires_in: acceso.expiraEnSegundos,",
      ],
    ],
    prueba: 'test/oauth2.e2e-spec.ts',
    filtro: 'sin refresh_token',
  },
  {
    nombre: 'formato-oauth: los errores de /oauth2/token salen como ProblemDetails',
    archivo: 'src/common/filters/errores.filter.ts',
    cambios: [['    if (ruta === RUTA_TOKEN) {', '    if (ruta === `${RUTA_TOKEN}-no`) {']],
    prueba: 'test/oauth2.e2e-spec.ts',
    filtro: 'JSON en lugar de formulario',
  },
  {
    nombre: 'loguea-token: el login escribe el token de acceso en el log',
    archivo: AUTH,
    cambios: [
      [
        '    const acceso = await this.tokens.emitir({ sub: usuario.id, scopes });',
        '    const acceso = await this.tokens.emitir({ sub: usuario.id, scopes });\n    this.logger.log(`token emitido para ${usuario.id}: ${acceso.token}`);',
      ],
    ],
    prueba: 'test/auditoria.e2e-spec.ts',
    filtro: 'ninguna fila',
  },
  {
    nombre: 'loguea-secreto: /oauth2/token escribe el secreto del cliente en el log',
    archivo: OAUTH,
    cambios: [
      [
        '    const valido = await this.contrasenas.verificar(cliente.hashSecreto, secreto);',
        "    const valido = await this.contrasenas.verificar(cliente.hashSecreto, secreto);\n    new (require('@nestjs/common').Logger)('OAuth2').debug(`secreto probado: ${secreto}`);",
      ],
    ],
    prueba: 'test/auditoria.e2e-spec.ts',
    filtro: 'ninguna fila',
  },
  {
    nombre: 'correo-completo: la auditoría guarda el correo sin enmascarar',
    archivo: 'src/modules/auditoria/auditoria.service.ts',
    cambios: [[': enmascararCorreo(evento.correoIntentado),', ': evento.correoIntentado,']],
    prueba: 'test/auditoria.e2e-spec.ts',
    filtro: 'cada evento deja su fila',
  },
  {
    nombre: 'reuso: reusar un refresh rotado no revoca la familia',
    archivo: AUTH,
    cambios: [
      [
        "      guardado.idFamilia,\n      'REUTILIZACION',",
        "      '00000000-0000-0000-0000-000000000000',\n      'REUTILIZACION',",
      ],
    ],
    prueba: 'test/auth.e2e-spec.ts',
    filtro: 'reusar un token ya rotado',
  },
  {
    nombre: '401-distinto: la cuenta inactiva responde con otro mensaje',
    archivo: AUTH,
    cambios: [
      [
        '      throw credencialesInvalidas();\n    }\n\n    fijarUsuario(usuario.id);',
        "      throw valida ? noAutenticado('The account is disabled') : credencialesInvalidas();\n    }\n\n    fijarUsuario(usuario.id);",
      ],
    ],
    prueba: 'test/auth.e2e-spec.ts',
    filtro: 'responden exactamente igual',
  },
  {
    nombre: 'tiempo: el correo inexistente no corre argon2',
    archivo: AUTH,
    cambios: [['      await this.contrasenas.verificarSinUsuario(dto.password);\n', '']],
    prueba: 'test/auth.e2e-spec.ts',
    filtro: 'tardan parecido',
  },
  {
    nombre: 'no-store: las respuestas con tokens se pueden guardar en caché',
    archivo: 'src/config/seguridad.ts',
    cambios: [['  app.use(sinCache(rutasSinCache));', '  void sinCache;']],
    prueba: 'test/auth.e2e-spec.ts',
    filtro: 'con las credenciales correctas',
  },
  {
    nombre: 'limite-login: 50 logins por minuto en lugar de 5',
    archivo: 'src/modules/auth/auth.controller.ts',
    cambios: [
      [
        '  login: { limite: 5, ventanaSegundos: 60 },',
        '  login: { limite: 50, ventanaSegundos: 60 },',
      ],
    ],
    prueba: 'test/limites.e2e-spec.ts',
    filtro: 'sexto intento',
  },
  {
    nombre: 'limite-cliente: sin límite por client_id',
    archivo: 'src/modules/oauth2/limite-por-cliente.ts',
    cambios: [
      [
        '  porCliente: { limite: 10, ventanaSegundos: 60 },',
        '  porCliente: { limite: 1000, ventanaSegundos: 60 },',
      ],
    ],
    prueba: 'test/limites.e2e-spec.ts',
    filtro: 'por cliente',
  },
  {
    nombre: 'openapi: un cambio en un controller sin regenerar el contrato',
    archivo: 'src/modules/auth/auth.controller.ts',
    cambios: [["    summary: 'Cerrar sesión',", "    summary: 'Cerrar la sesión',"]],
    prueba: 'test/openapi.e2e-spec.ts',
    filtro: 'está al día',
  },
  {
    nombre: 'clave-corta: el entorno acepta RSA de 1024 bits',
    archivo: 'src/modules/claves/material-claves.ts',
    cambios: [['export const BITS_MINIMOS_RSA = 2048;', 'export const BITS_MINIMOS_RSA = 1024;']],
    prueba: 'test/entorno.e2e-spec.ts',
    filtro: '1024 bits',
  },
];

const filtroNombre = process.argv[2];
const elegidas = MUTACIONES.filter((m) => !filtroNombre || m.nombre.includes(filtroNombre));
const resultados = [];

for (const mutacion of elegidas) {
  const original = readFileSync(mutacion.archivo, 'utf8');
  let mutado = original;
  const faltan = mutacion.cambios.filter(([buscar]) => original.split(buscar).length !== 2);
  if (faltan.length > 0) {
    resultados.push({ ...mutacion, estado: 'NO APLICABLE (el texto ya no está una sola vez)' });
    continue;
  }
  for (const [buscar, reemplazar] of mutacion.cambios)
    mutado = mutado.replace(buscar, () => reemplazar);
  try {
    writeFileSync(mutacion.archivo, mutado);
    const corrida = spawnSync(
      'npx',
      [
        'jest',
        '--config',
        'test/jest-e2e.json',
        '--runInBand',
        mutacion.prueba,
        '-t',
        mutacion.filtro,
      ],
      { encoding: 'utf8' },
    );
    const salida = `${corrida.stdout}${corrida.stderr}`;
    const fallidas = salida.match(/Tests:\s+(\d+) failed/)?.[1] ?? '0';
    resultados.push({
      ...mutacion,
      estado:
        corrida.status !== 0 && fallidas !== '0'
          ? `DETECTADA (${fallidas} prueba(s) fallan)`
          : 'SOBREVIVIÓ',
    });
  } finally {
    writeFileSync(mutacion.archivo, original);
  }
}

for (const r of resultados) {
  console.log(
    `${r.estado.startsWith('DETECTADA') ? 'ok ' : 'MAL'}  ${r.nombre}\n     ${r.prueba} -t "${r.filtro}" → ${r.estado}`,
  );
}
const malas = resultados.filter((r) => !r.estado.startsWith('DETECTADA'));
console.log(`\n${resultados.length - malas.length} de ${resultados.length} mutaciones detectadas`);
process.exit(malas.length === 0 ? 0 : 1);
