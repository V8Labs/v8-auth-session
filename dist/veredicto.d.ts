/**
 * ¿Este fallo de `/me` autoriza a CERRAR la sesión del dominio entero?
 *
 * ── DE DÓNDE VIENE ESTE ARCHIVO (auth, 2026-09-16) ──
 * Nació el 2026-09-15 en `app_V8_NOTIFICATIONS/src/lib/veredicto.ts` (commit
 * `2b8839a`, corregido en `7fd70c0`), y `app_V8_DIALOGUE` escribió la MISMA
 * regla, con horas de diferencia, en su propio `main.tsx` (`f8ab8a3`) — dos
 * implementaciones independientes de la misma decisión, el mismo día. Ninguna
 * de las dos eligió mal: es la prueba de que faltaba un lugar donde ponerla, no
 * un lugar de más.
 *
 * Se muda acá, al lado del llavero, por la misma razón por la que el
 * almacenamiento se centralizó el 2026-09-01 y dejó de morder: mecanismo
 * compartido, fijado por SHA, cero copias que envejecer.
 *
 * ⚠ **ÚNICA EXCEPCIÓN AL "MECANISMO, NO POLÍTICA" DEL RESTO DEL PAQUETE.** El
 * llavero no sabe qué hay en la sesión; este archivo sí sabe qué `error_code`
 * devuelve el `/me` de Mind. No es una grieta: es que esa política —qué
 * códigos son un veredicto de identidad— **es del ecosistema entero y no de
 * una app**, porque las cuatro que consumen `/me` (notifications, dialogue,
 * fashion, boletín-si-migra) reciben exactamente los mismos códigos del mismo
 * endpoint. Duplicarla por app fue justo el bug. Si mañana Mind cambia el
 * contrato de `/me`, este archivo es el ÚNICO lugar que hay que tocar.
 *
 * ── POR QUÉ ESTO ES UN MÓDULO Y NO TRES LÍNEAS EN `main.tsx` ──
 * Porque decide algo caro y silencioso. Cerrar de más saca al operador de las tres
 * apps del ecosistema en ese dispositivo, y el síntoma aparece al día siguiente,
 * lejos de la causa. Vive acá para tener BANCO DE PRUEBAS propio
 * (`scripts/test-veredicto.mjs`): montado dentro del `main.tsx` de una app,
 * cualquier cosa que viva ahí adentro es, por construcción, no testeable.
 *
 * ── EL BUG QUE LO TRAJO (auth, 2026-09-15) ──
 * Andy perdía la sesión TODOS LOS DÍAS, en Chrome del Mac y en iOS, y aterrizaba
 * en un login mudo. La cadena:
 *   1. `jwt_exp` = 8 h → el access token vence siempre de noche → la primera
 *      apertura del día es SIEMPRE un refresh.
 *   2. Si ese refresh no salía (red despertando, base lenta), el pedido a `/me`
 *      salía igual pero PELADO, sin `Authorization`.
 *   3. Mind contestaba `NO_AUTH` con status 401 — garantizado, no probable.
 *   4. La app leía «401» como «la base de operadores te rechazó» y llamaba a
 *      `signOutEverywhere()`, que borra la cookie compartida de `.v8labs.co`.
 * Un hipo de red se convertía en deslogueo permanente de todo el ecosistema.
 *
 * ── LA REGLA ──
 * `/me` devuelve 401 para TRES cosas que piden acciones opuestas:
 *   · veredicto de política (NO_OPERADOR, INACTIVO…) → SÍ cierra
 *   · `NO_AUTH` — no hay credencial válida            → NO cierra solo
 *   · `AUTH_NO_DISPONIBLE` — «no pude verificar»      → JAMÁS cierra
 * El tercero lleva literalmente el texto «Tu sesión sigue siendo válida».
 * El status por sí solo no los distingue; el `error_code` sí.
 */
/**
 * Lista CERRADA a propósito. Si Mind agrega un `error_code` nuevo mañana, el
 * default es CONSERVAR la sesión.
 *
 * La asimetría del costo es lo que fija el default: conservar de más cuesta un
 * operador que ve un error y reintenta; cerrar de más cuesta sacarlo de las tres
 * apps en todos sus dispositivos, todos los días, sin decirle por qué.
 *
 * ⚠ SON TRES, NO CINCO. La primera versión de este archivo (commit 2b8839a) tenía
 * también SIN_PERSONA y SIN_DEPARTAMENTO, porque así venía el pedido. `mind` lo
 * levantó y tiene razón — ver `VEREDICTOS_QUE_AVISAN` abajo.
 */
export declare const VEREDICTOS_QUE_CIERRAN: ReadonlySet<string>;
/**
 * ⭐ HUECOS DE FICHA: la sesión se CONSERVA y se le avisa al operador.
 *
 * No es cortesía, es mecánica: **cerrar la sesión ante un hueco de configuración
 * FABRICA un bucle de login.** El operador entra, `/me` rechaza, se destruye la
 * sesión, vuelve a entrar, mismo rechazo — porque lo que falta (su persona, su
 * departamento) lo carga OTRO, no él. Es el mismo bucle que este módulo vino a
 * matar, un escalón más arriba, y encima se lleva la sesión de las otras apps del
 * llavero por un campo vacío en una ficha.
 *
 * No abre un agujero: la sesión vive, pero `/me` sigue sin autorizar, así que no
 * habilita nada. Lo único que cambia es que el operador conserva el llavero y ve
 * un mensaje accionable en vez de un login que lo rechaza para siempre.
 */
export declare const VEREDICTOS_QUE_AVISAN: ReadonlySet<string>;
/** Forma mínima del error que tira `client.ts` en la rama 401/403. */
export type FalloDeMe = {
    status?: number;
    error_code?: string;
} | null | undefined;
/** El parámetro es `unknown` y no `FalloDeMe` a propósito: los llamadores lo reciben
 *  de un `catch`, donde TypeScript lo tipa `unknown`. Pedir el tipo angosto obligaría
 *  a cada punto de uso a hacer su propio cast — y un cast por llamador es una forma
 *  de que uno de ellos, algún día, castee mal y nadie se entere. */
/**
 * `true` SOLO si la base de operadores emitió un veredicto de expulsión.
 *
 * ⚠ Un 401 MUDO (sin `error_code`) devuelve `false` a propósito: puede ser
 * cualquiera de los tres casos, y ante la duda no se destruye nada. Antes del
 * 2026-09-15 la rama 401/403 de `client.ts` descartaba el body, así que el
 * `error_code` NUNCA llegaba hasta acá — o sea que este predicado solo sirve con
 * ese arreglo puesto. Si alguien vuelve a tirar el body, esto se vuelve un `false`
 * permanente y nadie cierra sesión nunca: ruidoso hacia el lado seguro, que es el
 * lado correcto para fallar.
 */
export declare function esVeredictoDeExpulsion(e: unknown): boolean;
/**
 * El `error_code` de un fallo que sea un veredicto de `/me` (401/403), o `null`.
 *
 * Es el dato que va a la cookie `v8_motivo_salida` para que el login deje de ser
 * mudo — y se escribe TAMBIÉN para los veredictos que NO cierran, porque son
 * justo los que más necesitan explicación: el operador conserva la sesión pero
 * igual no puede entrar, y sin mensaje eso se lee como una app rota.
 */
export declare function codigoDeFallo(e: unknown): string | null;
