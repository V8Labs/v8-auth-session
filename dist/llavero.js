/**
 * v8-auth-session — el llavero de sesión del ecosistema V8, en un solo lugar.
 *
 * ── POR QUÉ EXISTE ──
 * Esta lógica vivía COPIADA a mano en `app_V8_NOTIFICATIONS`, `app_V8_DIALOGUE` y
 * `app_V8_BOLETIN`. Las tres copias ya habían divergido: distinto md5, un tope de
 * chunks que solo tenía una, un contador de fallos sin identidad de sesión en otra,
 * y un sello de nacimiento con un punto en el nombre que lo metía adentro del
 * espacio de los chunks. Nadie las bifurcó a propósito: se copiaron y envejecieron.
 *
 * El gemelo servidor de este paquete es `V8Labs/v8-auth-jwt`, y su descripción dice
 * la misma frase que gobierna acá:
 *
 *     «Mecanismo, no política: distingue "token inválido" de "no pude verificar".»
 *
 * Este archivo es esa frase aplicada al NAVEGADOR.
 *
 * ── EL LLAVERO ES UN PARÁMETRO, Y ESO NO ES UN DETALLE ──
 * Un error natural al unificar tres copias es unificar también la SESIÓN. Sería un
 * error caro: hoy Andy entra a boletín con su correo de vendedor y a XO con su
 * correo de operador, AL MISMO TIEMPO, y eso funciona solo porque boletín quedó con
 * otra `storageKey` (`v8boletinauth`) mientras el resto comparte `v8auth`. Las dos
 * cookies viven en el mismo `.v8labs.co`; lo único que las separa es el NOMBRE.
 *
 * Así que acá se comparte el MECANISMO y no la IDENTIDAD. Cada app declara su
 * llavero; dos llaveros distintos no se ven entre sí, a propósito.
 *
 * ⚠ Corolario: NO unifiques `storageKey` entre apps "para simplificar". Eso no
 * simplifica — fusiona dos identidades que hoy conviven, y el síntoma es que entrar
 * a una app te saca de la otra.
 */
const CHUNK = 3000;
const MAX_AGE = 60 * 60 * 24 * 365;
/**
 * Tope duro de chunks (venía de la copia de DIALOGUE, Gemini 2026-08-17; las otras
 * dos NO lo tenían). Una cookie corrupta o manipulada con un contador enorme hacía
 * a los loops de lectura y de barrido iterar sin límite — freeze sincrónico de la
 * pestaña. 200 × 3000 = 600 KB, muy por encima de cualquier sesión real: un valor
 * mayor es corrupción, no una sesión legítima.
 *
 * Que solo una de las tres copias lo tuviera es el argumento entero de este paquete.
 */
const MAX_CHUNKS = 200;
export function crearLlavero(opts) {
    const KEY = opts.storageKey;
    if (!KEY || /[;,\s=]/.test(KEY)) {
        // Un nombre con `;` o `=` rompe el parseo de cookies y lo hace de forma
        // silenciosa y difícil de leer. Se rechaza al construir, no al usar.
        throw new Error(`v8-auth-session: storageKey inválida: ${JSON.stringify(KEY)}`);
    }
    const ahora = opts.ahora ?? (() => Date.now());
    const MAX_FALLOS = opts.maxFallos ?? 3;
    const VIDA_MAXIMA_DIAS = opts.vidaMaximaDias ?? 60;
    const AVISO_DESDE_DIAS = opts.avisoDesdeDias ?? 7;
    /**
     * ⚠ Los auxiliares se DERIVAN de la storageKey, y con `_` y no con `.`.
     *
     * Dos razones, y las dos son bugs que existían:
     *  1. **Sin derivar**, dos llaveros en el mismo dominio comparten el sello y el
     *     contador. La sesión de boletín le movería el contador de fallos a la de
     *     tareas — cookies distintas, mismo `.v8labs.co`.
     *  2. **Con punto**, el nombre cae DENTRO del espacio de los chunks (`KEY.<n>`).
     *     `app_V8_BOLETIN` tenía `v8boletinauth.nacida` justamente así. Hoy es latente
     *     (los barridos son numéricos), pero es una trampa esperando a que alguien
     *     escriba un barrido por prefijo.
     */
    const FALLOS_KEY = `${KEY}_fallos`;
    const NACIDA_KEY = `${KEY}_nacida`;
    const HINT_KEY = opts.hintCorreoKey === undefined ? `${KEY}_last_email` : opts.hintCorreoKey;
    const enV8 = typeof window !== 'undefined' && window.location?.hostname?.endsWith('v8labs.co');
    const cookieDomain = opts.cookieDomain === undefined ? (enV8 ? '.v8labs.co' : null) : opts.cookieDomain;
    function cookieAttrs(maxAge) {
        const parts = ['path=/', `max-age=${maxAge}`, 'samesite=lax'];
        // `secure` en TODO https (no solo en v8labs.co): iOS en modo PWA no persiste
        // de forma confiable una cookie no-secure, y el espejo es justo el fallback
        // para cuando el PWA limpia el localStorage. En http (dev) no se agrega.
        if (typeof location !== 'undefined' && location.protocol === 'https:')
            parts.push('secure');
        if (cookieDomain)
            parts.push(`domain=${cookieDomain}`);
        return '; ' + parts.join('; ');
    }
    function readCookie(name) {
        if (typeof document === 'undefined')
            return null;
        const hit = document.cookie.split('; ').find((c) => c.startsWith(name + '='));
        return hit ? hit.slice(name.length + 1) : null;
    }
    // Escribir cookies PUEDE TIRAR (modo privado, WebViews, storage bloqueado por el
    // navegador). Estas dos son de "hacer el intento": si no se puede, no hay nada que
    // salvar, y una excepción acá sale del adaptador hacia auth-js, que no la espera.
    // No lo encontró nadie leyendo el código: lo cazó el banco al simular cookies
    // bloqueadas — sin el guard, `removeItem` lanzaba en vez de degradarse.
    function clearCookie(name) {
        try {
            document.cookie = `${name}=${cookieAttrs(0)}`;
        }
        catch { /* sin cookies */ }
    }
    function escribirCookie(name, value, maxAge) {
        try {
            document.cookie = `${name}=${value}${cookieAttrs(maxAge)}`;
        }
        catch { /* sin cookies */ }
    }
    /** `decodeURIComponent` TIRA `URIError` con un escape malformado (`%zz`), y una
     *  cookie NO es un campo privado: cualquiera en el dominio la escribe y sobrevive
     *  a los recargues. Sin este guard, basura en la cookie reventaba la
     *  inicialización de auth-js → **app en blanco PERMANENTE** en ese navegador,
     *  porque la cookie mala vuelve en cada arranque y el operador no tiene cómo
     *  sacarla. Y con `domain=.v8labs.co`, se llevaba puestas todas las apps del
     *  llavero a la vez. (LORD, nocturno 2026-08-17, vía `boletin`.) */
    function decodificar(raw) {
        if (raw === null)
            return null;
        try {
            return decodeURIComponent(raw);
        }
        catch {
            return null;
        }
    }
    /** Cuántos chunks dice el contador, ya acotado. Un contador ilegible se trata
     *  como 0: no se barren chunks viejos. Peor caso queda una cookie huérfana que la
     *  próxima escritura pisa — infinitamente mejor que no poder escribir la sesión. */
    function contarChunks(key) {
        const n = parseInt(decodificar(readCookie(key)) ?? '', 10);
        if (!Number.isFinite(n) || n <= 0)
            return 0;
        return Math.min(n, MAX_CHUNKS);
    }
    function writeChunkedCookies(key, value) {
        const enc = encodeURIComponent(value);
        const chunks = [];
        for (let i = 0; i < enc.length; i += CHUNK)
            chunks.push(enc.slice(i, i + CHUNK));
        const prevN = contarChunks(key);
        for (let i = chunks.length; i < prevN; i++)
            clearCookie(`${key}.${i}`);
        escribirCookie(key, encodeURIComponent(String(chunks.length)), MAX_AGE);
        chunks.forEach((c, i) => escribirCookie(`${key}.${i}`, c, MAX_AGE));
    }
    /** Reensambla la sesión de la cookie compartida (`key`=n + `key.0..n-1`).
     *  Devuelve null si falta el contador o CUALQUIER chunk — un valor a medias es
     *  peor que ninguno: auth-js lo tomaría por sesión corrupta y desloguearía. */
    function leerDeCookie(key) {
        const n = contarChunks(key);
        if (n <= 0)
            return null;
        let joined = '';
        for (let i = 0; i < n; i++) {
            const part = readCookie(`${key}.${i}`);
            if (part === null)
                return null;
            joined += part;
        }
        return decodificar(joined);
    }
    /** Borra la cookie compartida y sus chunks. Solo desde un logout explícito. */
    function clearSharedCookie(key) {
        // Si el contador no se pudo leer, barremos un rango razonable igual: una cookie
        // huérfana con la sesión vieja es peor que unos `document.cookie` de más.
        const n = contarChunks(key) || 8;
        clearCookie(key);
        for (let i = 0; i < n; i++)
            clearCookie(`${key}.${i}`);
        // El sello muere con la sesión que describía. Si sobreviviera, el próximo login
        // heredaría la edad del anterior y pediría renovar una sesión recién nacida.
        clearCookie(NACIDA_KEY);
    }
    // ───────────────────────────────────────────────────────────────────────────
    // ⭐ EL VEREDICTO: una caída del backend NO es una sesión muerta (2026-09-01)
    // ───────────────────────────────────────────────────────────────────────────
    /**
     * EL BUG QUE ARREGLA. El 2026-09-01 Supabase estuvo ~20 minutos sin contestar
     * (`http=000`, timeout a los 15 s). auth-js llama `removeItem` en CADA refresh
     * fallido —incluidos los timeouts de red—, así que se acumularon tres fallos
     * sobre la misma sesión, se desalojó la cookie compartida, y **Andy y los
     * vendedores quedaron afuera de todas las apps del llavero**. Cuando el backend
     * volvió, la sesión ya no estaba.
     *
     * El desalojo por insistencia no distinguía "sesión genuinamente muerta" de
     * "servidor inalcanzable": tres timeouts se veían idénticos a tres rechazos de un
     * refresh token revocado. Y el banco de pruebas no lo cazó porque su primer caso
     * AFIRMA el desalojo al tercer fallo — no podía distinguirlos más que el código.
     *
     * LA DISTINCIÓN, que sale de la medición del incidente: un `http=000` (nadie
     * contestó) no es un `400` del endpoint de token (contestó y dijo que no). Solo el
     * segundo es un veredicto sobre la credencial. Es la misma frase de `v8-auth-jwt`,
     * de este lado del cable.
     *
     * ⚠ **EL DEFAULT ES `true` (concluyente) A PROPÓSITO.** Si no tenemos información,
     * el llavero se comporta como antes y sigue contando. El modo de falla que hay que
     * evitar por sobre todos es el OTRO: una cookie envenenada que no se puede
     * desalojar nunca es el bucle infinito que dejó a Andy afuera el 15-ago. Ante la
     * duda **se cuenta**, nunca se protege de más.
     */
    let refreshConcluyente = true;
    /** ¿El status del endpoint de token es un veredicto sobre la credencial? */
    function esVeredicto(status) {
        if (status === null)
            return false; // no hubo respuesta: red, DNS, TLS, timeout
        if (status === 408 || status === 429)
            return false; // timeout / rate-limit: no es del token
        if (status >= 500)
            return false; // el servidor se cayó, no juzgó nada
        return true; // 2xx/4xx: GoTrue se pronunció
    }
    function marcarResultadoRefresh(status) {
        refreshConcluyente = esVeredicto(status);
    }
    /**
     * Lee el veredicto Y LO CONSUME. Consumirlo es esencial: si un fallo de red
     * dejara la marca puesta, un rechazo posterior y genuino tampoco contaría, y la
     * cookie envenenada volvería a ser indesalojable. Un fallo de red suprime como
     * mucho UN conteo.
     */
    function tomarVeredicto() {
        const v = refreshConcluyente;
        refreshConcluyente = true;
        return v;
    }
    /** ¿Esta URL es el endpoint que refresca la sesión? */
    function esRefreshDeSesion(url) {
        return url.includes('/auth/v1/token');
    }
    const fetchConVeredicto = async (input, init) => {
        const url = typeof input === 'string' ? input
            : input instanceof URL ? input.href
                : input.url;
        if (!esRefreshDeSesion(url))
            return fetch(input, init);
        try {
            const r = await fetch(input, init);
            marcarResultadoRefresh(r.status);
            return r;
        }
        catch (e) {
            // No llegó respuesta: DNS, TLS, timeout, offline. La sesión no dijo nada.
            marcarResultadoRefresh(null);
            throw e;
        }
    };
    // ── Identidad y edad de la sesión ──────────────────────────────────────────
    /** Identidad de una sesión guardada: `expires_at` + usuario. Cambia en cada
     *  refresco exitoso, que es lo que hace que el contador se limpie solo. */
    function identidadSesion(raw) {
        if (!raw)
            return null;
        try {
            const s = JSON.parse(raw);
            if (typeof s?.expires_at !== 'number')
                return null;
            return `${s.expires_at}:${s.user?.id ?? ''}`;
        }
        catch {
            return null;
        }
    }
    /** `expires_at` (epoch s) de una sesión serializada. -1 si no se puede leer. */
    function expiraEn(raw) {
        if (!raw)
            return -1;
        try {
            const s = JSON.parse(raw);
            return typeof s?.expires_at === 'number' ? s.expires_at : -1;
        }
        catch {
            return -1;
        }
    }
    /** El claim `session_id` del access token. Es lo ÚNICO que identifica a la sesión
     *  a través de los refrescos: los tokens rotan, el `session_id` no. */
    function sessionIdDe(raw) {
        if (!raw)
            return null;
        try {
            const jwt = JSON.parse(raw)?.access_token;
            if (typeof jwt !== 'string')
                return null;
            const payload = jwt.split('.')[1];
            if (!payload)
                return null;
            // base64url → base64. `atob` no acepta `-` ni `_`, y el JWT no lleva padding.
            const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
            const claims = JSON.parse(atob(b64 + '=='.slice(0, (4 - (b64.length % 4)) % 4)));
            return typeof claims?.session_id === 'string' ? claims.session_id : null;
        }
        catch {
            return null;
        }
    }
    /** Sella el nacimiento si la sesión es NUEVA. Un refresco trae el mismo
     *  `session_id` → no se toca el sello: la edad se cuenta desde el login. */
    function sellarNacimiento(raw) {
        const sid = sessionIdDe(raw);
        if (sid === null)
            return;
        // La LECTURA del sello anterior se aísla de la ESCRITURA a propósito. En el
        // mismo `try`, un sello ilegible —basura que otro escribió en el dominio— hace
        // saltar al catch y **no se sella nunca más**: la cookie mala sobrevive y
        // bloquea el aviso de renovación para siempre, en silencio.
        let prev = null;
        try {
            const raw2 = decodificar(readCookie(NACIDA_KEY));
            prev = raw2 ? JSON.parse(raw2) : null;
        }
        catch {
            prev = null;
        }
        if (prev?.sid === sid && typeof prev?.t === 'number')
            return; // ya sellada
        try {
            escribirCookie(NACIDA_KEY, encodeURIComponent(JSON.stringify({ sid, t: ahora() })), MAX_AGE);
        }
        catch { /* sin cookies: no hay aviso, pero nada se rompe */ }
    }
    /**
     * Cuánto lleva viva la sesión. `null` si no hay sello — y eso NO es un error:
     * pasa con toda sesión anterior a este cambio y con cookies bloqueadas.
     *
     * **Ante la duda no se avisa.** Un aviso de "renová" sobre una sesión cuya edad no
     * conocemos empuja a un re-login que nadie necesitaba.
     *
     * ⚠ Esto AVISA, no expulsa. Un sello del lado del cliente se puede borrar, así que
     * no es un control de seguridad: quien corta de verdad es el `sessions_timebox`
     * del servidor.
     */
    function edadDeSesion() {
        try {
            const raw = decodificar(readCookie(NACIDA_KEY));
            if (raw === null)
                return null;
            const { t } = JSON.parse(raw);
            if (typeof t !== 'number' || !Number.isFinite(t))
                return null;
            const dias = Math.floor((ahora() - t) / 86_400_000);
            if (dias < 0)
                return null; // reloj movido hacia atrás: no inventamos nada
            const restan = VIDA_MAXIMA_DIAS - dias;
            return { dias, restan, porVencer: restan <= AVISO_DESDE_DIAS };
        }
        catch {
            return null;
        }
    }
    // ── Contador de desalojo por insistencia ───────────────────────────────────
    /** Suma un fallo contra `id`. Devuelve cuántos van seguidos para ESA sesión.
     *
     *  ⚠ EL CONTADOR VIVE EN UNA COOKIE, no en localStorage (LORD, 16-ago). El bucle
     *  de auth-js pasa por RECARGAS, así que un contador que no persiste nunca llega
     *  al tope — y no llegar significa **no desalojar nunca**, que ES el bucle
     *  infinito. En modo privado o con la cuota llena, el operador quedaba encerrado
     *  leyendo la cookie envenenada para siempre.
     *
     *  Y el default ante fallo es **desalojar**: si no podemos contar, la salida
     *  segura es soltar la cookie —se cae a localStorage, que es lo que había antes—
     *  y no quedarse encerrado. NUNCA devolver 1 acá. */
    function contarFallo(id) {
        try {
            const prevRaw = decodificar(readCookie(FALLOS_KEY));
            const prev = prevRaw ? JSON.parse(prevRaw) : null;
            const n = prev?.id === id ? (prev?.n ?? 0) + 1 : 1;
            // Efímero (10 min): un contador viejo no debe condenar a una sesión futura.
            escribirCookie(FALLOS_KEY, encodeURIComponent(JSON.stringify({ id, n })), 600);
            // Si la escritura no pasó (cookies bloqueadas), el contador no avanza nunca →
            // hay que desalojar igual, que es la salida segura.
            if (readCookie(FALLOS_KEY) === null)
                return MAX_FALLOS;
            return n;
        }
        catch {
            return MAX_FALLOS; // no se puede contar → desalojar, nunca encerrar
        }
    }
    function limpiarFallos() {
        try {
            clearCookie(FALLOS_KEY);
        }
        catch { /* ignore */ }
    }
    // ── Salidas explícitas ─────────────────────────────────────────────────────
    /**
     * Cuántas salidas explícitas hay EN CURSO. Marca que el borrado que viene es un
     * logout QUERIDO, no una falla de refresh — el único caso en el que la sesión
     * compartida debe morir.
     *
     * ⚠ ES UN CONTADOR Y NO UN BOOLEANO, y la diferencia es un bug real (`boletin`,
     * 17-ago). Con un booleano y dos salidas SOLAPADAS —un doble toque en el botón,
     * que en un mostrador pasa todo el tiempo— la primera en terminar apaga el flag y
     * la segunda deja el respaldo vivo: el operador ve que salió y su sesión sigue
     * disponible para el próximo que agarre el teléfono.
     */
    let salidas = 0;
    async function conSalidaExplicita(fn) {
        salidas++;
        try {
            await fn();
        }
        finally {
            // ⚠ EL ORDEN IMPORTA (LORD 2026-08-13). El contador se baja PRIMERO: si se
            // bajara después de una llamada que tira, quedaría en >0 PARA SIEMPRE — y con
            // él arriba, cada `removeItem` vuelve a ser destructivo sobre la cookie
            // compartida. El deslogueo en cadena de todo el llavero, en silencio.
            salidas = Math.max(0, salidas - 1);
        }
    }
    function limpiarTodo() {
        try {
            clearSharedCookie(KEY);
        }
        catch { /* ya no puede romper nada */ }
        limpiarFallos();
        // El hint de correo muere con la salida EXPLÍCITA y solo con ella. Una sesión
        // que vence sola conserva el hint a propósito; acá alguien dijo "cerrá sesión"
        // —típicamente en un teléfono prestado— y dejar su correo escrito en la próxima
        // pantalla sería exactamente lo contrario de lo que pidió.
        if (HINT_KEY)
            clearCookie(HINT_KEY);
    }
    // ── El adaptador de storage ────────────────────────────────────────────────
    const storage = {
        getItem: (key) => {
            let ls = null;
            try {
                ls = window.localStorage.getItem(key);
            }
            catch { /* ignore */ }
            if (ls !== null) {
                // Espejo cross-subdominio: si LS tiene la verdad pero la cookie compartida
                // se perdió (eviction, limpieza, primer ingreso a este origin), re-sembrarla.
                // Sin esto, una app ve sesión propia y manda a otra, que no la ve y rebota
                // de vuelta → bucle. (Andy 2026-06-01)
                if (readCookie(key) === null) {
                    try {
                        writeChunkedCookies(key, ls);
                    }
                    catch { /* ignore */ }
                    return ls;
                }
                // ⚠ NO devolver localStorage sin mirar la cookie (arreglado 2026-08-15).
                //
                // `localStorage` es POR ORIGIN, y las apps de un mismo llavero son orígenes
                // distintos: cada una tiene su copia, pero la SESIÓN es una sola y la cookie
                // es lo único compartido. Cuando una app refresca, escribe el token nuevo en
                // la cookie; las otras seguían leyendo su localStorage VIEJO y presentando un
                // refresh token ya rotado → "Possible abuse attempt" y sesión revocada: entrar
                // a una segunda app deslogueaba de la primera.
                //
                // El lock interno de auth-js (`navigatorLock`) NO cubre esto: es por ORIGIN.
                // Coordina pestañas de la misma app, nunca apps distintas. Lo compartido entre
                // orígenes es la cookie, así que la cookie tiene que poder GANAR — y gana la
                // sesión que expira más tarde, que es la más nueva.
                //
                // ⚠ ESTA REGLA YA EXPLOTÓ UNA VEZ (15-ago, Andy afuera 1h28m). Lo que la
                // vuelve segura es que la cookie AHORA sí se puede desalojar (removeItem, por
                // insistencia). Un portador que no se puede invalidar no puede tener prioridad.
                const desdeCookie = leerDeCookie(key);
                if (desdeCookie !== null && expiraEn(desdeCookie) > expiraEn(ls)) {
                    try {
                        window.localStorage.setItem(key, desdeCookie);
                    }
                    catch { /* ignore */ }
                    return desdeCookie;
                }
                return ls;
            }
            const desdeCookie = leerDeCookie(key);
            if (desdeCookie !== null) {
                try {
                    window.localStorage.setItem(key, desdeCookie);
                }
                catch { /* ignore */ }
            }
            return desdeCookie;
        },
        setItem: (key, value) => {
            try {
                window.localStorage.setItem(key, value);
            }
            catch { /* ignore */ }
            writeChunkedCookies(key, value);
            // Va DESPUÉS de guardar: si algo fallara acá, lo que no puede perderse es la
            // sesión — el sello solo alimenta un aviso, y su ausencia degrada a "no avisar".
            sellarNacimiento(value);
            // Se guardó una sesión: lo que había fallado, dejó de fallar. El crédito se
            // devuelve acá y no por tiempo, así un refresco exitoso —venga de esta app o de
            // otra del mismo llavero— siempre le devuelve la vida completa a la cookie.
            limpiarFallos();
        },
        /**
         * ⚠ NO borra la cookie compartida salvo logout EXPLÍCITO (Andy 2026-08-12).
         *
         * auth-js llama `removeItem` cada vez que decide que la sesión murió, y eso
         * incluye un refresh fallido. Como la cookie es del dominio, ese borrado se
         * llevaba puesta la sesión de TODAS las apps del llavero: un hipo transitorio en
         * UNA pestaña = todos afuera. Andy lo reportó como "se sale muy frecuente".
         *
         * Ahora el localStorage local sí se limpia (esa app perdió su sesión y es
         * verdad), pero la cookie compartida queda, y en el próximo `getItem` esa app se
         * recupera leyendo lo que las otras mantuvieron vivo. El sistema se auto-cura en
         * vez de cascadear.
         */
        removeItem: (key) => {
            // El localStorage se limpia SIEMPRE: auth-js lo necesita vacío para reintentar
            // limpio, y no es el respaldo.
            try {
                window.localStorage.removeItem(key);
            }
            catch { /* ignore */ }
            if (salidas > 0) {
                clearSharedCookie(key);
                limpiarFallos();
                return;
            }
            // ⭐ Se consume el veredicto ACÁ, antes de las salidas tempranas, para que un
            // fallo de red no quede marcado esperando a un `removeItem` posterior que sí
            // era un rechazo genuino.
            const huboVeredicto = tomarVeredicto();
            // No es un logout: auth-js decidió que la sesión murió. Puede ser un hipo de
            // red (no hay que tocar nada) o una sesión genuinamente muerta que quedó pegada
            // en la cookie (hay que desalojarla o el llavero entra en bucle).
            const enCookie = leerDeCookie(key);
            if (enCookie === null)
                return; // nada que desalojar
            const id = identidadSesion(enCookie);
            if (id === null) {
                clearSharedCookie(key);
                return;
            } // ilegible = inservible
            // ⭐ EL ARREGLO DEL 2026-09-01: si el backend no se pronunció, esto no cuenta.
            // No sabemos nada nuevo sobre la sesión, así que no gastamos una de sus vidas.
            if (!huboVeredicto)
                return;
            if (contarFallo(id) >= MAX_FALLOS) {
                // Fallos consecutivos sobre la MISMA sesión, TODOS con veredicto del
                // servidor. No va a revivir: sacarla es lo único que permite que el próximo
                // arranque lea algo distinto.
                clearSharedCookie(key);
                limpiarFallos();
            }
        },
    };
    return {
        storage,
        fetch: fetchConVeredicto,
        conSalidaExplicita,
        limpiarTodo,
        edadDeSesion,
        nombres: { sesion: KEY, fallos: FALLOS_KEY, nacida: NACIDA_KEY, hintCorreo: HINT_KEY },
        _marcarResultadoRefresh: marcarResultadoRefresh,
    };
}
