#!/usr/bin/env node
/**
 * Banco del VEREDICTO — qué 401 puede cerrar la sesión del dominio.
 *
 * ── DE DÓNDE VIENE ──
 * Portado desde `app_V8_NOTIFICATIONS/scripts/test-veredicto.mjs` (2026-09-15,
 * commit `2b8839a` + `7fd70c0`) al mudar el módulo a este paquete (2026-09-16).
 * El banco no cambió: sigue siendo el mismo que cazó el bug real.
 *
 * ── POR QUÉ EXISTE ──
 * Andy perdía la sesión todos los días y aterrizaba en un login mudo. La causa
 * (diagnosticada por `auth`, 2026-09-15) era que la app trataba «401» como
 * sinónimo de «la base de operadores te rechazó», cuando `/me` devuelve 401 para
 * tres cosas distintas — y una de ellas (`AUTH_NO_DISPONIBLE`) lleva literalmente
 * el texto «Tu sesión sigue siendo válida».
 *
 * ── LA LECCIÓN QUE ESTE BANCO TIENE QUE HONRAR (handoff 2026-08-30) ──
 * Ya pasó tener 43 pruebas EN VERDE con el bug adentro, porque el doble era
 * incapaz de reproducir la falla. Así que la pregunta acá no es «¿pasa?» sino
 * «¿este banco puede FALLAR como falla lo real?». Por eso el caso 1 es el bug
 * exacto que vivió Andy: si alguien vuelve a decidir por el status, ESE caso se
 * pone rojo. Se verifica con `node scripts/test-veredicto.mjs --demo-bug`, que
 * corre la lógica VIEJA contra los mismos casos y tiene que fallar.
 *
 *     node scripts/test-veredicto.mjs
 */
import { build } from 'esbuild';
import { unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(tmpdir(), `veredicto-${process.pid}.mjs`);

await build({
  entryPoints: [join(raiz, 'src/veredicto.ts')],
  bundle: true, format: 'esm', outfile: out, logLevel: 'silent',
});
// `finally` y no un `unlinkSync` al hilo (LORD, review 2026-09-16, portado desde
// `app_V8_NOTIFICATIONS` commit `07b84fb`): si el módulo falla al evaluarse —un
// error de sintaxis en `veredicto.ts`— el import tira y el temporal queda
// huérfano en disco, una fuga por cada corrida rota.
let mod;
try {
  mod = await import(pathToFileURL(out).href);
} finally {
  unlinkSync(out);
}
const { esVeredictoDeExpulsion, VEREDICTOS_QUE_CIERRAN, VEREDICTOS_QUE_AVISAN, codigoDeFallo, buscarMotivo } = mod;

/** La lógica VIEJA, la que causó el bug. Solo para el modo --demo-bug. */
const logicaVieja = (e) => e?.status === 401 || e?.status === 403;

const CASOS = [
  // ── Lo que NO debe cerrar: el corazón del arreglo ──
  ['⭐ el bug de Andy: refresh falla → pedido pelado → NO_AUTH 401',
   { status: 401, error_code: 'NO_AUTH' }, false],
  ['AUTH_NO_DISPONIBLE — "no pude verificar", jamás cierra',
   { status: 401, error_code: 'AUTH_NO_DISPONIBLE' }, false],
  ['401 MUDO (sin error_code) — puede ser cualquiera de los tres',
   { status: 401 }, false],
  ['403 mudo tampoco cierra',
   { status: 403 }, false],
  ['error_code desconocido del futuro → default CONSERVAR',
   { status: 401, error_code: 'ALGO_NUEVO_DE_MIND' }, false],
  ['sin sesión local: ni sale el pedido, no hay status',
   { error_code: 'SIN_SESION_LOCAL' }, false],
  // ⭐ Los dos que `mind` sacó de la lista: cerrar ante un hueco de FICHA fabrica
  // un bucle de login, porque lo que falta lo carga otro, no el operador.
  ['SIN_PERSONA avisa pero NO cierra (bucle de login)',
   { status: 401, error_code: 'SIN_PERSONA' }, false],
  ['SIN_DEPARTAMENTO avisa pero NO cierra (bucle de login)',
   { status: 403, error_code: 'SIN_DEPARTAMENTO' }, false],
  ['hipo de red: sin status ni code', {}, false],
  ['timeout / 500 del Mind no es veredicto', { status: 500 }, false],
  ['503 de Mind (auth indeterminada) no es veredicto', { status: 503 }, false],
  ['null / undefined no explotan', null, false],
  [
   'veredicto correcto pero con status que no rechaza → no cierra',
   { status: 200, error_code: 'NO_OPERADOR' }, false],

  // ── Lo que SÍ debe cerrar: los tres veredictos de política ──
  ['NO_OPERADOR cierra',      { status: 401, error_code: 'NO_OPERADOR' },      true],
  ['INACTIVO cierra',         { status: 401, error_code: 'INACTIVO' },         true],
  ['NO_GMAIL cierra',         { status: 401, error_code: 'NO_GMAIL' },         true],
];

/** El motivo tiene que llegar a la pantalla TAMBIÉN cuando no se cierra: esos son
 *  justo los casos donde el operador conserva sesión y aun así no puede entrar. */
const CASOS_MOTIVO = [
  ['SIN_DEPARTAMENTO deja motivo aunque no cierre', { status: 401, error_code: 'SIN_DEPARTAMENTO' }, 'SIN_DEPARTAMENTO'],
  ['NO_OPERADOR deja motivo',                       { status: 401, error_code: 'NO_OPERADOR' },      'NO_OPERADOR'],
  ['un 500 no deja motivo (no es veredicto)',        { status: 500, error_code: 'X' },                null],
  ['401 mudo no inventa motivo',                     { status: 401 },                                 null],
];

const demo = process.argv.includes('--demo-bug');
const fn = demo ? logicaVieja : esVeredictoDeExpulsion;
if (demo) {
  console.log('── MODO --demo-bug: corriendo la lógica VIEJA (status pelado).');
  console.log('   Tiene que FALLAR. Si pasa, este banco no prueba nada.\n');
}

let ok = 0, fail = 0;
console.log('── ¿Qué 401 puede cerrar la sesión del dominio? ──');
for (const [nombre, entrada, esperado] of CASOS) {
  const real = fn(entrada);
  if (real === esperado) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fail++; console.log(`  ✗ ${nombre} — esperaba ${esperado}, dio ${real}`); }
}

if (!demo) {
  console.log('\n── ¿Llega el motivo a la pantalla? ──');
  for (const [nombre, entrada, esperado] of CASOS_MOTIVO) {
    const real = codigoDeFallo(entrada);
    if (real === esperado) { ok++; console.log(`  ✓ ${nombre}`); }
    else { fail++; console.log(`  ✗ ${nombre} — esperaba ${esperado}, dio ${real}`); }
  }
}

// Las listas son cerradas: que nadie les agregue un veredicto sin pasar por acá.
console.log('\n── Las listas ──');
const cierran = ['INACTIVO', 'NO_GMAIL', 'NO_OPERADOR'];
const avisan = ['SIN_DEPARTAMENTO', 'SIN_PERSONA'];
const rc = [...VEREDICTOS_QUE_CIERRAN].sort();
const ra = [...(VEREDICTOS_QUE_AVISAN ?? [])].sort();
if (JSON.stringify(rc) === JSON.stringify(cierran)) {
  ok++; console.log('  ✓ CIERRAN: exactamente 3 (NO_OPERADOR · INACTIVO · NO_GMAIL)');
} else {
  fail++;
  console.log(`  ✗ la lista que CIERRA cambió: ${rc.join(', ')}`);
  console.log('    Agregar uno amplía quién queda afuera del ecosistema entero.');
  console.log('    Ojo con SIN_PERSONA/SIN_DEPARTAMENTO: estuvieron acá y fabricaban');
  console.log('    un bucle de login, porque el hueco lo llena otro, no el operador.');
}
if (JSON.stringify(ra) === JSON.stringify(avisan)) {
  ok++; console.log('  ✓ AVISAN: exactamente 2 (SIN_PERSONA · SIN_DEPARTAMENTO)');
} else { fail++; console.log(`  ✗ la lista que AVISA cambió: ${ra.join(', ')}`); }

// Las dos listas no pueden solaparse: un código no puede cerrar y conservar a la vez.
const solape = rc.filter((c) => ra.includes(c));
if (solape.length === 0) { ok++; console.log('  ✓ las dos listas no se solapan'); }
else { fail++; console.log(`  ✗ ${solape.join(', ')} está en las DOS listas`); }

// ── buscarMotivo: el `code` sale de una cookie de dominio compartido ────────
// Portado desde `app_V8_NOTIFICATIONS` (LORD, review 2026-09-16, commit
// `07b84fb`): ese `motivoDeSalida()` hacía `ERROR_MESSAGES[code] ?? generico`,
// y con `code === 'toString'` el lookup devuelve una FUNCIÓN, no null — React
// se rompe pintándola. Se prueba la FUNCIÓN REAL del módulo, no una réplica:
// una réplica prueba que la LECCIÓN se entendió, no que el CÓDIGO la aplica.
if (!demo) {
  console.log('\n── ¿buscarMotivo sobrevive a una clave del prototipo? ──');
  const DICC = { NO_OPERADOR: 'no sos operador', INACTIVO: 'cuenta inactiva' };
  const HOSTILES = ['toString', 'constructor', 'valueOf', 'hasOwnProperty'];
  for (const code of HOSTILES) {
    const real = buscarMotivo(DICC, code);
    if (real === null) { ok++; console.log(`  ✓ "${code}" → null, no una función`); }
    else { fail++; console.log(`  ✗ "${code}" devolvió ${typeof real} — no es seguro pintarlo`); }
  }
  if (buscarMotivo(DICC, 'NO_OPERADOR') === 'no sos operador') {
    ok++; console.log('  ✓ un código real sigue mapeando bien');
  } else { fail++; console.log('  ✗ se rompió el mapeo de un código real'); }
  if (buscarMotivo(DICC, 'CODIGO_DEL_FUTURO') === null) {
    ok++; console.log('  ✓ un código desconocido da null (el llamador decide el genérico)');
  } else { fail++; console.log('  ✗ un código desconocido no dio null'); }
  if (buscarMotivo(DICC, null) === null) {
    ok++; console.log('  ✓ code=null no explota');
  } else { fail++; console.log('  ✗ code=null no dio null'); }

  // Y el banco tiene que saber fallar: la versión ingenua SÍ tiene que romperse
  // con las mismas claves, o esto no estaría probando nada.
  const ingenuo = (code) => DICC[code] ?? 'genérico';
  if (HOSTILES.some((c) => typeof ingenuo(c) !== 'string')) {
    ok++; console.log('  ✓ ⭐ y el lookup con `??` SÍ se rompe (este banco sabe fallar)');
  } else {
    fail++; console.log('  ✗ el lookup con `??` no se rompió — entonces esto no prueba nada');
  }
}

console.log(fail === 0 ? `\n✅ ${ok}/${ok}` : `\n❌ ${fail} de ${ok + fail} fallaron`);
if (demo) {
  process.exit(fail > 0 ? 0 : 1); // en demo, PASAR sería el problema
}
process.exit(fail === 0 ? 0 : 1);
