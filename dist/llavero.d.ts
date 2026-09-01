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
/** El reloj. Inyectable SOLO para el banco de pruebas: sin esto, probar "la sesión
 *  nació hace 53 días" exige esperar 53 días o mutar `Date` global, que es peor. */
export type Reloj = () => number;
export type LlaveroOpts = {
    /**
     * El nombre de la llave de sesión. **Es la identidad del llavero**: dos apps con
     * la misma `storageKey` comparten sesión; con distinta, no se ven.
     * Hoy en uso: `v8auth` (tareas · XO/dialogue · metrics) y `v8boletinauth` (boletín).
     */
    storageKey: string;
    /**
     * Dominio de la cookie espejo. `null` = sin `domain`, o sea que la cookie NO cruza
     * subdominios y el llavero queda encerrado en su origen.
     * Default: `.v8labs.co` si el host termina en `v8labs.co`, `null` si no (localhost).
     */
    cookieDomain?: string | null;
    /** Fallos CONSECUTIVOS sobre la misma sesión antes de desalojar la cookie. */
    maxFallos?: number;
    /** Techo de vida de la sesión, para el AVISO de renovación (no expulsa). */
    vidaMaximaDias?: number;
    /** Cuántos días antes del techo se empieza a avisar. */
    avisoDesdeDias?: number;
    /** Cookie del hint de correo. `null` = esta app no guarda hint. */
    hintCorreoKey?: string | null;
    /** Solo para el banco. */
    ahora?: Reloj;
};
export type EdadSesion = {
    /** Días completos desde el login. */
    dias: number;
    /** Días que faltan para el techo. Negativo si ya lo pasó. */
    restan: number;
    /** true cuando entra en la ventana de aviso (o ya venció). */
    porVencer: boolean;
};
export type Almacen = {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
};
export type Llavero = {
    /** El adaptador para `createClient({ auth: { storage } })`. */
    storage: Almacen;
    /**
     * El `fetch` para `createClient({ global: { fetch } })`.
     * ⚠ **No es opcional.** Sin él, el llavero no puede distinguir "el backend no
     * contestó" de "el servidor rechazó el token", y vuelve el bug del 2026-09-01.
     */
    fetch: typeof fetch;
    /** Corre `fn` con permiso de destruir la sesión compartida (logout de verdad). */
    conSalidaExplicita: (fn: () => Promise<unknown>) => Promise<void>;
    /** Borra la cookie compartida, sus chunks, el sello y el hint. Logout explícito. */
    limpiarTodo: () => void;
    /** Cuánto lleva viva la sesión. `null` si no hay sello — y eso NO es un error. */
    edadDeSesion: () => EdadSesion | null;
    /**
     * Sella el nacimiento a partir de un access token suelto.
     *
     * Normalmente no hace falta: `setItem` ya sella en cada guardado. Existe para el
     * arranque — una sesión **restaurada desde la cookie** entra por `getItem` y no
     * pasa por `setItem`, así que sin esto no se sellaría hasta el primer refresco.
     * `app_V8_BOLETIN` lo llama explícitamente en su `main.tsx` por esa razón.
     *
     * Es idempotente: el mismo `session_id` no re-sella (la edad se cuenta desde el
     * login, no desde el último arranque).
     */
    sellarConAccessToken: (jwt: string | null | undefined) => void;
    /** Los nombres derivados, para que la app no los adivine ni los reescriba. */
    nombres: {
        sesion: string;
        fallos: string;
        nacida: string;
        hintCorreo: string | null;
    };
    /**
     * Primitivas de cookie con EXACTAMENTE los atributos de la sesión (`domain`,
     * `secure`, `samesite`, `path`). Se exportan porque cosas como el hint de correo
     * necesitan viajar entre subdominios igual que la sesión: si cada app copiara los
     * cuatro atributos, un día divergirían y el hint dejaría de cruzar sin que nadie
     * lo note. Una sola fuente para los atributos.
     */
    cookies: {
        leer: (nombre: string) => string | null;
        escribir: (nombre: string, valor: string, maxAge?: number) => void;
        borrar: (nombre: string) => void;
        MAX_AGE: number;
    };
    /** Solo para el banco de pruebas. No lo use la app. */
    _marcarResultadoRefresh: (status: number | null) => void;
};
export declare function crearLlavero(opts: LlaveroOpts): Llavero;
