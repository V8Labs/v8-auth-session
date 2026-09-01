#!/usr/bin/env node
/**
 * Banco de pruebas del llavero de sesión.
 *
 * ── POR QUÉ EXISTE ──
 * Esta lógica dejó a Andy AFUERA de la app tres veces:
 *   · 2026-08-15 — cookie envenenada indesalojable, 93 rechazos en 12 s.
 *   · 2026-09-01 — Supabase caído ~20 min; tres refrescos con timeout se contaron
 *     como tres rechazos y se desalojó una sesión perfectamente viva.
 * Leer el código no alcanzó ninguna de las veces.
 *
 * ⚠ Y el banco viejo TAMPOCO alcanzó la segunda vez: su primer caso AFIRMABA el
 * desalojo al tercer fallo, sin distinguir de qué fallo se trataba. Un banco que
 * codifica el bug lo protege. Por eso los casos 21-27 no son "más cobertura": son
 * la distinción que faltaba.
 *
 *     node scripts/test-llavero.mjs
 *
 * No necesita framework: monta `localStorage`, `document.cookie` y `fetch` de
 * mentira sobre el módulo compilado al vuelo con esbuild.
 */
import { build } from 'esbuild';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── Dobles de navegador ──────────────────────────────────────────────────────
function montarNavegador() {
  const ls = new Map();
  let cookies = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (k) => (ls.has(k) ? ls.get(k) : null),
      setItem: (k, v) => ls.set(k, String(v)),
      removeItem: (k) => ls.delete(k),
    },
    location: { hostname: 'tareas.v8labs.co', protocol: 'https:' },
  };
  globalThis.location = window.location;
  globalThis.document = {
    get cookie() {
      return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    set cookie(str) {
      const [par, ...attrs] = str.split(';').map((s) => s.trim());
      const i = par.indexOf('=');
      const k = par.slice(0, i);
      const v = par.slice(i + 1);
      if (attrs.some((a) => /^max-age=0$/i.test(a))) cookies.delete(k);
      else cookies.set(k, v);
    },
  };
  return {
    ls,
    verCookies: () => cookies,
    reset: () => { cookies = new Map(); ls.clear(); },
    /** Escribe una cookie SIN pasar por el setter, para sembrar lo que nuestro
     *  código nunca produciría. Una cookie NO es un campo privado: cualquiera en el
     *  dominio la escribe, y el problema vive justo en los valores que no generamos. */
    sembrarCruda: (k, v) => cookies.set(k, v),
    /**
     * Bloquea `document.cookie` (modo privado, WebViews) y DEVUELVE cómo restaurarlo.
     * ⚠ Devolver el restaurador no es prolijidad: la primera versión de este doble no
     * lo hacía, y el caso que bloqueaba las cookies **contaminaba en silencio todos
     * los casos que corrieran después** — un test posterior fallaba por una razón que
     * no tenía nada que ver con lo que probaba. Un doble que no se puede deshacer
     * convierte al banco en dependiente del orden.
     */
    bloquearCookies: () => {
      const original = Object.getOwnPropertyDescriptor(globalThis.document, 'cookie');
      Object.defineProperty(globalThis.document, 'cookie', {
        configurable: true,
        get() { return ''; },
        set() { throw new Error('cookies bloqueadas'); },
      });
      return () => Object.defineProperty(globalThis.document, 'cookie', original);
    },
  };
}

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwtCon = (sid) => `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ session_id: sid })}.firma`;

/** Sesión serializada como la guarda supabase-js. */
const sesion = (dentroDe, uid = 'u1', sid = 's1') =>
  JSON.stringify({
    expires_at: Math.floor(Date.now() / 1000) + dentroDe,
    user: { id: uid },
    access_token: jwtCon(sid),
  });

let fallos = 0;
let total = 0;
const check = (nombre, ok, detalle = '') => {
  total++;
  if (ok) console.log(`  ✓ ${nombre}`);
  else { fallos++; console.log(`  ✗ ${nombre}${detalle ? ' — ' + detalle : ''}`); }
};

// ── Compilar el módulo real ──────────────────────────────────────────────────
// PID en el nombre + borrado en `finally`: con nombre fijo, dos corridas en
// paralelo se pisan el módulo compilado; y si el import falla, el temporal quedaba
// tirado en el repo. Las señales se enganchan aparte (`exit` no corre con Ctrl+C).
const tmp = join(raiz, 'scripts', `.llavero.tmp.${process.pid}.mjs`);
const out = await build({
  entryPoints: [join(raiz, 'src/llavero.ts')],
  bundle: true, format: 'esm', write: false, target: 'es2022', platform: 'neutral',
});
writeFileSync(tmp, out.outputFiles[0].text);
const limpiar = () => { try { unlinkSync(tmp); } catch { /* ya no está */ } };
process.on('exit', limpiar);
for (const [sig, num] of Object.entries({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 })) {
  process.on(sig, () => { limpiar(); process.exit(128 + num); });
}

const nav = montarNavegador();
const { crearLlavero } = await import(`file://${tmp}?t=${Date.now()}`);

const KEY = 'v8auth';
/** Un llavero limpio, con reloj inyectable para no esperar 53 días. */
const nuevo = (opts = {}) => crearLlavero({ storageKey: KEY, ...opts });

console.log('\nBanco de pruebas · llavero de sesión V8\n');
console.log('── Precedencia y espejo cross-subdominio ──');

// 1 · La cookie MÁS NUEVA gana (el caso cross-app que hay que resolver)
nav.reset();
let hs = nuevo().storage;
window.localStorage.setItem(KEY, sesion(600));
hs.setItem(KEY, sesion(600));
window.localStorage.setItem(KEY, sesion(600));
hs.setItem(KEY, sesion(7200));            // otra app refrescó: cookie nueva
window.localStorage.setItem(KEY, sesion(600)); // y la local sigue vieja
check('cookie más nueva le gana a localStorage',
  JSON.parse(hs.getItem(KEY)).expires_at > Math.floor(Date.now() / 1000) + 3600);

// 2 · "Abrir la app al otro día": AMBAS con el access vencido, gana la cookie.
// Un guard `vigente()` que descartara toda cookie con access vencido devolvía la
// local vieja → "Possible abuse attempt" → sesión revocada. ERA el bug, no el fix.
nav.reset();
hs = nuevo().storage;
hs.setItem(KEY, sesion(-100, 'u1', 's1'));     // cookie: refrescada anoche
window.localStorage.setItem(KEY, sesion(-9000)); // local: mucho más vieja
check('con AMBAS vencidas, gana la cookie (la última refrescada)',
  expira(hs.getItem(KEY)) === expira(leerCookieSesion()));

// 3 · Si LS tiene la verdad y la cookie se perdió, se re-siembra
nav.reset();
hs = nuevo().storage;
window.localStorage.setItem(KEY, sesion(3600));
const devuelto = hs.getItem(KEY);
check('LS sin cookie → re-siembra el espejo y devuelve LS',
  devuelto !== null && nav.verCookies().get(KEY) !== undefined);

// 4 · Cookie sin LS → se hidrata el LS
nav.reset();
hs = nuevo().storage;
hs.setItem(KEY, sesion(3600));
window.localStorage.removeItem(KEY);
check('cookie sin LS → hidrata localStorage', hs.getItem(KEY) !== null);

// 5 · Chunks: una sesión grande viaja entera
nav.reset();
hs = nuevo().storage;
const grande = JSON.stringify({ expires_at: 9e9, user: { id: 'u1' }, relleno: 'x'.repeat(7000) });
hs.setItem(KEY, grande);
window.localStorage.removeItem(KEY);
check('sesión de >3 chunks se reensambla completa', hs.getItem(KEY) === grande);

// 6 · Falta un chunk → null, NUNCA un valor a medias
nav.reset();
hs = nuevo().storage;
hs.setItem(KEY, grande);
window.localStorage.removeItem(KEY);
nav.verCookies().delete(`${KEY}.1`);
check('chunk faltante → null (nunca una sesión a medias)', hs.getItem(KEY) === null);

console.log('\n── Desalojo por insistencia ──');

// 7 · Cookie envenenada se desaloja al 3er RECHAZO DEL SERVIDOR
nav.reset();
let lv = nuevo();
lv.storage.setItem(KEY, sesion(-100, 'u1', 's1'));
window.localStorage.removeItem(KEY);
for (let i = 0; i < 3; i++) { lv._marcarResultadoRefresh(400); lv.storage.removeItem(KEY); }
check('cookie envenenada se desaloja al 3er rechazo del servidor',
  nav.verCookies().get(KEY) === undefined);

// 8 · Un fallo aislado + refresco exitoso NO desaloja
nav.reset();
lv = nuevo();
lv.storage.setItem(KEY, sesion(-100));
lv._marcarResultadoRefresh(400); lv.storage.removeItem(KEY);
lv.storage.setItem(KEY, sesion(3600));           // otra app refrescó
lv._marcarResultadoRefresh(400); lv.storage.removeItem(KEY);
check('fallo aislado + refresco exitoso NO desaloja',
  nav.verCookies().get(KEY) !== undefined);

// 9 · Cookie ilegible se desaloja de una (inservible, no hay nada que contar)
nav.reset();
lv = nuevo();
nav.sembrarCruda(KEY, encodeURIComponent('1'));
nav.sembrarCruda(`${KEY}.0`, encodeURIComponent('no-es-json'));
lv._marcarResultadoRefresh(400);
lv.storage.removeItem(KEY);
check('cookie ilegible se desaloja sin contar', nav.verCookies().get(KEY) === undefined);

console.log('\n── ⭐ EL ARREGLO: backend caído ≠ sesión muerta (2026-09-01) ──');

// 10 · EL CASO DEL INCIDENTE: el backend no contesta, la sesión NO se toca
nav.reset();
lv = nuevo();
lv.storage.setItem(KEY, sesion(-100, 'u1', 's1'));
window.localStorage.removeItem(KEY);
for (let i = 0; i < 10; i++) { lv._marcarResultadoRefresh(null); lv.storage.removeItem(KEY); }
check('backend caído: 10 timeouts NO desalojan la sesión',
  nav.verCookies().get(KEY) !== undefined,
  'esto es exactamente lo que saco a Andy el 2026-09-01');

// 11 · 5xx tampoco es un veredicto sobre el token
nav.reset();
lv = nuevo();
lv.storage.setItem(KEY, sesion(-100));
window.localStorage.removeItem(KEY);
for (let i = 0; i < 5; i++) { lv._marcarResultadoRefresh(503); lv.storage.removeItem(KEY); }
check('503 del servidor NO desaloja (se cayó, no juzgó)',
  nav.verCookies().get(KEY) !== undefined);

// 12 · 429 tampoco — y esto tiene historia: 93 rate-limits en 12 s el 15-ago
nav.reset();
lv = nuevo();
lv.storage.setItem(KEY, sesion(-100));
window.localStorage.removeItem(KEY);
for (let i = 0; i < 5; i++) { lv._marcarResultadoRefresh(429); lv.storage.removeItem(KEY); }
check('429 (rate-limit) NO desaloja', nav.verCookies().get(KEY) !== undefined);

// 13 · 408 tampoco
nav.reset();
lv = nuevo();
lv.storage.setItem(KEY, sesion(-100));
window.localStorage.removeItem(KEY);
for (let i = 0; i < 5; i++) { lv._marcarResultadoRefresh(408); lv.storage.removeItem(KEY); }
check('408 (timeout) NO desaloja', nav.verCookies().get(KEY) !== undefined);

// 14 · ⚠ EL DEFAULT ES CONTAR. Sin información, se comporta como antes.
// Protegerse de más es el bucle infinito del 15-ago: una cookie que no se puede
// desalojar nunca. Ante la duda se cuenta.
nav.reset();
lv = nuevo();
lv.storage.setItem(KEY, sesion(-100));
window.localStorage.removeItem(KEY);
for (let i = 0; i < 3; i++) lv.storage.removeItem(KEY);   // sin marcar nada
check('sin información, el default es CONTAR (y desaloja al 3ro)',
  nav.verCookies().get(KEY) === undefined,
  'protegerse de más recrea el bucle indesalojable del 15-ago');

// 15 · El veredicto SE CONSUME: un fallo de red suprime UN conteo, no todos
nav.reset();
lv = nuevo();
lv.storage.setItem(KEY, sesion(-100, 'u1', 's1'));
window.localStorage.removeItem(KEY);
lv._marcarResultadoRefresh(null); lv.storage.removeItem(KEY);   // red: no cuenta
for (let i = 0; i < 3; i++) { lv._marcarResultadoRefresh(400); lv.storage.removeItem(KEY); }
check('el veredicto se consume: red no inmuniza a los rechazos siguientes',
  nav.verCookies().get(KEY) === undefined);

// 16 · El fetch envuelto clasifica solo, sin que nadie marque a mano
nav.reset();
const URL_TOKEN = 'https://x.supabase.co/auth/v1/token?grant_type=refresh_token';
lv = nuevo();
lv.storage.setItem(KEY, sesion(-100));
window.localStorage.removeItem(KEY);
globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
for (let i = 0; i < 3; i++) {
  try { await lv.fetch(URL_TOKEN); } catch { /* esperado */ }
  lv.storage.removeItem(KEY);
}
check('el fetch envuelto clasifica una excepción de red como NO-veredicto',
  nav.verCookies().get(KEY) !== undefined);

// 17 · …y clasifica un 400 real como veredicto
nav.reset();
lv = nuevo();
lv.storage.setItem(KEY, sesion(-100));
window.localStorage.removeItem(KEY);
globalThis.fetch = async () => ({ status: 400 });
for (let i = 0; i < 3; i++) { await lv.fetch(URL_TOKEN); lv.storage.removeItem(KEY); }
check('el fetch envuelto clasifica un 400 como veredicto (y desaloja)',
  nav.verCookies().get(KEY) === undefined);

// 18 · Una URL que NO es el refresh no toca el veredicto
nav.reset();
lv = nuevo();
let pasoDerecho = false;
globalThis.fetch = async () => { pasoDerecho = true; return { status: 500 }; };
await lv.fetch('https://x.supabase.co/rest/v1/tabla');
lv.storage.setItem(KEY, sesion(-100));
window.localStorage.removeItem(KEY);
for (let i = 0; i < 3; i++) lv.storage.removeItem(KEY);
check('una URL que no es /auth/v1/token no altera el veredicto',
  pasoDerecho && nav.verCookies().get(KEY) === undefined);

console.log('\n── ⭐ Aislamiento entre llaveros (vendedor en boletín + operador en XO) ──');

// 19 · Dos llaveros conviven: sesiones distintas, sin pisarse
nav.reset();
const eco = crearLlavero({ storageKey: 'v8auth' });
const bol = crearLlavero({ storageKey: 'v8boletinauth' });
eco.storage.setItem('v8auth', sesion(3600, 'operador', 'sOp'));
bol.storage.setItem('v8boletinauth', sesion(3600, 'vendedor', 'sVe'));
check('dos llaveros sostienen DOS identidades a la vez',
  JSON.parse(eco.storage.getItem('v8auth')).user.id === 'operador' &&
  JSON.parse(bol.storage.getItem('v8boletinauth')).user.id === 'vendedor');

// 20 · Desalojar uno NO toca al otro (el caso que rompía si unificábamos la llave)
for (let i = 0; i < 3; i++) { eco._marcarResultadoRefresh(400); eco.storage.removeItem('v8auth'); }
check('desalojar el llavero del ecosistema NO desloguea a boletín',
  nav.verCookies().get('v8auth') === undefined &&
  nav.verCookies().get('v8boletinauth') !== undefined);

// 21 · Los contadores de fallo son independientes
check('cada llavero tiene su propio contador de fallos',
  eco.nombres.fallos !== bol.nombres.fallos);

// 22 · Ningún auxiliar cae en el espacio de nombres de los chunks (`KEY.<n>`).
// `app_V8_BOLETIN` tenía `v8boletinauth.nacida`, justo adentro. Latente, pero es
// una trampa esperando a que alguien escriba un barrido por prefijo.
check('los nombres derivados NO usan punto (no colisionan con los chunks)',
  !bol.nombres.fallos.includes('.') && !bol.nombres.nacida.includes('.') &&
  !eco.nombres.fallos.includes('.') && !eco.nombres.nacida.includes('.'));

// 23 · Una storageKey que rompería el parseo de cookies se rechaza al construir
let tiro = false;
try { crearLlavero({ storageKey: 'mal=nombre' }); } catch { tiro = true; }
check('storageKey inválida se rechaza al construir, no al usar', tiro);

console.log('\n── Edad de la sesión (aviso de renovación) ──');

const DIA = 86_400_000;
const conReloj = (t) => crearLlavero({ storageKey: KEY, ahora: () => t });

// 24 · Guardar una sesión nueva sella su nacimiento
nav.reset();
let t0 = 1_700_000_000_000;
let l = conReloj(t0);
l.storage.setItem(KEY, sesion(3600, 'u1', 'sA'));
check('guardar una sesión nueva sella su nacimiento', l.edadDeSesion()?.dias === 0);

// 25 · Un refresco NO reinicia la edad (mismo session_id)
l = conReloj(t0 + 10 * DIA);
l.storage.setItem(KEY, sesion(3600, 'u1', 'sA'));   // mismo sid = refresco
check('un refresco NO reinicia la edad (mismo session_id)', l.edadDeSesion()?.dias === 10);

// 26 · Un login nuevo re-sella y la edad vuelve a cero
l = conReloj(t0 + 10 * DIA);
l.storage.setItem(KEY, sesion(3600, 'u1', 'sB'));   // sid distinto = login nuevo
check('un login nuevo re-sella y la edad vuelve a cero', l.edadDeSesion()?.dias === 0);

// 27 · Sin sello no hay edad, y por lo tanto no hay aviso.
// Ante la duda NO se avisa: un "renová" sobre una sesión cuya edad no conocemos
// empuja a un re-login que nadie necesitaba.
nav.reset();
check('sin sello no hay edad (y por lo tanto no hay aviso)',
  conReloj(t0).edadDeSesion() === null);

// 28 · El aviso se enciende recién en la ventana de renovación
nav.reset();
l = conReloj(t0);
l.storage.setItem(KEY, sesion(3600, 'u1', 'sA'));
check('a los 50 días todavía NO avisa', conReloj(t0 + 50 * DIA).edadDeSesion()?.porVencer === false);
check('a los 54 días YA avisa', conReloj(t0 + 54 * DIA).edadDeSesion()?.porVencer === true);
check('pasado el techo sigue avisando, con restan negativo',
  conReloj(t0 + 70 * DIA).edadDeSesion()?.restan === -10);

// 29 · Reloj movido hacia atrás: no inventamos una edad
check('reloj hacia atrás → null, no una edad negativa',
  conReloj(t0 - 5 * DIA).edadDeSesion() === null);

console.log('\n── Salidas explícitas ──');

// 30 · El logout explícito SÍ destruye el respaldo compartido
nav.reset();
lv = nuevo();
lv.storage.setItem(KEY, sesion(3600));
await lv.conSalidaExplicita(async () => { lv.storage.removeItem(KEY); });
check('el logout explícito destruye el respaldo compartido',
  nav.verCookies().get(KEY) === undefined);

// 31 · Dos salidas SOLAPADAS (doble toque en el mostrador): el respaldo muere igual.
// Con un booleano en vez de contador, la primera en terminar apagaba el flag y la
// segunda dejaba la sesión viva para el próximo que agarrara el teléfono.
nav.reset();
lv = nuevo();
lv.storage.setItem(KEY, sesion(3600));
let resolver;
const lenta = new Promise((r) => { resolver = r; });
const a = lv.conSalidaExplicita(() => lenta);
const b = lv.conSalidaExplicita(async () => { lv.storage.removeItem(KEY); });
await b; resolver(); await a;
check('dos salidas solapadas: el respaldo se destruye igual',
  nav.verCookies().get(KEY) === undefined);

// 32 · Cerradas las salidas, removeItem vuelve a ser NO destructivo
nav.reset();
lv = nuevo();
lv.storage.setItem(KEY, sesion(3600));
await lv.conSalidaExplicita(async () => {});
lv._marcarResultadoRefresh(400);
lv.storage.removeItem(KEY);
check('cerradas las salidas, removeItem vuelve a ser no destructivo',
  nav.verCookies().get(KEY) !== undefined);

// 33 · Si la salida TIRA, el contador igual baja (si no, todo removeItem
// posterior queda destructivo PARA SIEMPRE, en silencio)
nav.reset();
lv = nuevo();
lv.storage.setItem(KEY, sesion(3600));
try { await lv.conSalidaExplicita(async () => { throw new Error('signOut falló'); }); } catch { /* esperado */ }
lv._marcarResultadoRefresh(400);
lv.storage.removeItem(KEY);
check('una salida que TIRA no deja el flag destructivo prendido',
  nav.verCookies().get(KEY) !== undefined);

// 34 · `limpiarTodo` borra sesión, chunks, sello y hint
nav.reset();
lv = nuevo();
lv.storage.setItem(KEY, grande);
nav.sembrarCruda(lv.nombres.hintCorreo, 'a%40b.co');
lv.limpiarTodo();
check('limpiarTodo borra sesión, chunks, sello y hint',
  nav.verCookies().get(KEY) === undefined &&
  nav.verCookies().get(`${KEY}.0`) === undefined &&
  nav.verCookies().get(lv.nombres.nacida) === undefined &&
  nav.verCookies().get(lv.nombres.hintCorreo) === undefined);

console.log('\n── Valores envenenados (una cookie NO es un campo privado) ──');

// 35 · Escape malformado en getItem — el camino de CADA arranque
nav.reset();
lv = nuevo();
nav.sembrarCruda(KEY, '%zz');
let reventó = false;
try { lv.storage.getItem(KEY); } catch { reventó = true; }
check('cookie con escape malformado NO revienta getItem', !reventó);

// 36 · …ni setItem, que corre en CADA refresco de token (o sea cada hora)
nav.reset();
lv = nuevo();
nav.sembrarCruda(KEY, '%zz');
reventó = false;
try { lv.storage.setItem(KEY, sesion(3600)); } catch { reventó = true; }
check('cookie con escape malformado NO revienta setItem (el refresco horario)', !reventó);

// 37 · Contador de fallos envenenado no revienta removeItem
nav.reset();
lv = nuevo();
lv.storage.setItem(KEY, sesion(-100));
nav.sembrarCruda(lv.nombres.fallos, '%zz');
reventó = false;
try { lv._marcarResultadoRefresh(400); lv.storage.removeItem(KEY); } catch { reventó = true; }
check('contador de fallos envenenado NO revienta removeItem', !reventó);

// 38 · Sello envenenado: no revienta Y se pisa con uno nuevo
nav.reset();
lv = conReloj(t0);
nav.sembrarCruda(lv.nombres.nacida, '%zz');
lv.storage.setItem(KEY, sesion(3600, 'u1', 'sC'));
check('sello envenenado no revienta Y se pisa con uno nuevo', lv.edadDeSesion()?.dias === 0);

// 39 · Contador de chunks absurdo: no cuelga la pestaña (tope duro)
nav.reset();
lv = nuevo();
nav.sembrarCruda(KEY, encodeURIComponent('999999999'));
const t1 = Date.now();
lv.storage.getItem(KEY);
check('contador de chunks absurdo no cuelga la pestaña (tope duro)', Date.now() - t1 < 500);

// 40 · Con cookies que TIRAN, todo degrada sin propagar hacia auth-js
nav.reset();
lv = nuevo();
const restaurar = nav.bloquearCookies();
reventó = false;
try {
  lv.storage.setItem(KEY, sesion(3600));
  lv.storage.getItem(KEY);
  lv.storage.removeItem(KEY);
  lv.limpiarTodo();
} catch { reventó = true; }
restaurar();
check('con cookies que TIRAN, todo degrada sin propagar', !reventó);


console.log('\n── Primitivas de cookie (mismos atributos que la sesión) ──');

// 41 · Roundtrip del hint de correo, con encoding
nav.reset();
lv = nuevo();
lv.cookies.escribir('v8_last_email', 'a+b@correo.co');
check('las primitivas de cookie hacen roundtrip con encoding',
  lv.cookies.leer('v8_last_email') === 'a+b@correo.co');

// 42 · Un valor envenenado por un tercero devuelve null, no revienta
nav.reset();
lv = nuevo();
nav.sembrarCruda('v8_last_email', '%zz');
reventó = false;
let leido;
try { leido = lv.cookies.leer('v8_last_email'); } catch { reventó = true; }
check('un valor de cookie envenenado devuelve null, no revienta', !reventó && leido === null);

// 43 · borrar deja la cookie fuera
lv.cookies.escribir('v8_last_email', 'x@y.co');
lv.cookies.borrar('v8_last_email');
check('borrar saca la cookie', lv.cookies.leer('v8_last_email') === null);


console.log('\n── Sellado explícito desde el arranque (boletín) ──');

// 46 · Una sesión restaurada desde la cookie no pasa por setItem: sin el sellado
// explícito no tendría edad, y por lo tanto nunca avisaría la renovación.
nav.reset();
l = conReloj(t0);
l.sellarConAccessToken(jwtCon('sBoot'));
check('sellarConAccessToken sella una sesión restaurada', l.edadDeSesion()?.dias === 0);

// 47 · Es idempotente: re-sellar el MISMO session_id no reinicia la edad
l = conReloj(t0 + 20 * DIA);
l.sellarConAccessToken(jwtCon('sBoot'));
check('re-sellar el mismo session_id NO reinicia la edad', l.edadDeSesion()?.dias === 20);

// 48 · Un token basura no rompe ni sella nada
nav.reset();
l = conReloj(t0);
reventó = false;
try { l.sellarConAccessToken('no-es-un-jwt'); l.sellarConAccessToken(null); } catch { reventó = true; }
check('un access token basura no revienta ni inventa un sello',
  !reventó && l.edadDeSesion() === null);

// ── Helpers que necesitan el scope del módulo ────────────────────────────────
function expira(raw) { try { return JSON.parse(raw).expires_at; } catch { return null; } }
function leerCookieSesion() {
  const n = parseInt(decodeURIComponent(nav.verCookies().get(KEY) ?? '0'), 10);
  let j = '';
  for (let i = 0; i < n; i++) j += nav.verCookies().get(`${KEY}.${i}`) ?? '';
  try { return decodeURIComponent(j); } catch { return null; }
}

console.log(`\n${fallos === 0 ? '✅' : '❌'} ${total - fallos}/${total}\n`);
process.exit(fallos === 0 ? 0 : 1);
