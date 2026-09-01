# v8-auth-session

Llavero de sesión del ecosistema V8, para el **navegador**.

Gemelo cliente de [`v8-auth-jwt`](https://github.com/V8Labs/v8-auth-jwt), y con la misma
frase de gobierno, aplicada de este lado del cable:

> **Mecanismo, no política: distingue «token inválido» de «no pude verificar».**

---

## Por qué existe

Esta lógica vivía **copiada a mano en tres repos** (`app_V8_NOTIFICATIONS`,
`app_V8_DIALOGUE`, `app_V8_BOLETIN`). Nadie las bifurcó a propósito: se copiaron y
envejecieron por separado. Al unificarlas aparecieron las divergencias:

| | NOTIFICATIONS | DIALOGUE | BOLETIN |
|---|---|---|---|
| tope de chunks (`MAX_CHUNKS`) | ✗ | ✓ | ✗ |
| contador de fallos con identidad de sesión | ✓ | ✓ | ✗ (global) |
| sello fuera del espacio de los chunks | ✓ | ✓ | ✗ (`v8boletinauth.nacida`) |

Tres copias, tres subconjuntos distintos de las lecciones ya pagadas.

## El llavero es un parámetro — y eso NO es un detalle

Al unificar tres copias, el error natural es unificar también **la sesión**. Sería caro:
hoy Andy entra a boletín con su correo de **vendedor** y a XO con su correo de
**operador**, al mismo tiempo, y eso funciona únicamente porque boletín quedó con otra
`storageKey`. Las dos cookies viven en el mismo `.v8labs.co`; lo único que las separa es
el **nombre**.

Así que acá se comparte el **mecanismo** y no la **identidad**:

```
v8auth          →  tareas · XO/dialogue · metrics   (pasan por el gateway `on`)
v8boletinauth   →  boletín                          (no pasa por `on`)
```

> ⚠ **No unifiques `storageKey` entre apps "para simplificar".** Eso no simplifica:
> fusiona dos identidades que hoy conviven, y el síntoma es que entrar a una app te saca
> de la otra.

Todos los nombres auxiliares (contador de fallos, sello de nacimiento, hint de correo) se
**derivan** de la `storageKey`, con `_` y nunca con `.`. Dos llaveros no se pisan, y ningún
auxiliar cae dentro del espacio de nombres de los chunks (`KEY.<n>`).

## Uso

```ts
import { crearLlavero } from 'v8-auth-session';
import { createClient } from '@supabase/supabase-js';

export const llavero = crearLlavero({ storageKey: 'v8auth' });

export const supabase = createClient(url, anonKey, {
  auth: {
    storage: llavero.storage,
    storageKey: llavero.nombres.sesion,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce',
  },
  global: { fetch: llavero.fetch },   // ⚠ NO opcional
});
```

**`global.fetch` no es opcional.** Sin él el llavero no puede distinguir «el backend no
contestó» de «el servidor rechazó el token», y vuelve el bug del 2026-09-01.

Para el logout de verdad:

```ts
export async function salir() {
  try { await llavero.conSalidaExplicita(() => supabase.auth.signOut()); }
  finally { llavero.limpiarTodo(); }
}
```

## El arreglo del 2026-09-01

Supabase estuvo ~20 minutos sin contestar (`http=000`, timeout a los 15 s). auth-js llama
`removeItem` en **cada** refresh fallido —incluidos los timeouts—, así que se acumularon
tres fallos sobre la misma sesión, se desalojó la cookie compartida, y los operadores y
vendedores quedaron afuera de todas las apps del llavero. Cuando el backend volvió, la
sesión ya no estaba.

El desalojo por insistencia no distinguía **«sesión muerta»** de **«servidor
inalcanzable»**. Ahora sí: solo cuenta como fallo lo que el servidor **juzgó**.

| respuesta del endpoint de token | ¿gasta una vida de la sesión? |
|---|---|
| 2xx / 4xx (salvo 408 y 429) | **sí** — GoTrue se pronunció |
| sin respuesta (red, DNS, TLS, timeout) | no |
| 5xx | no — se cayó, no juzgó |
| 408 · 429 | no — timeout / rate-limit, no es del token |

> ⚠ **El default es CONTAR.** Sin información el llavero se comporta como antes. El modo
> de falla que hay que evitar por sobre todos es el otro: una cookie envenenada que no se
> puede desalojar nunca es el bucle infinito que dejó a Andy afuera el 15-ago. **Ante la
> duda se cuenta, nunca se protege de más.**

## Banco de pruebas

```
npm test        # 42 casos
```

Se corre **antes** de tocar `getItem`/`setItem`/`removeItem`. Esta lógica dejó a Andy
afuera de la app dos veces y leerla no alcanzó ninguna de las dos.

⚠ Y el banco anterior tampoco alcanzó la segunda vez: su primer caso **afirmaba** el
desalojo al tercer fallo sin distinguir de qué fallo se trataba. Un banco que codifica el
bug lo protege.

## Cómo se importa — por SHA, nunca por tag

Un tag se puede mover (`git tag -f && git push -f`) y todos los consumidores traen otro
código **sin que cambie una línea del suyo**. Para un módulo que decide si una credencial
vale, esa comodidad no paga la superficie. Misma regla que `v8-auth-jwt`.

```json
"dependencies": {
  "v8-auth-session": "github:V8Labs/v8-auth-session#<SHA>"
}
```

| versión | SHA | notas |
|---|---|---|
| `1.0.0` | _(se completa al publicar)_ | primera; unifica las 3 copias + arreglo del 01-sep |

Actualizar exige un acto deliberado. En un módulo de credenciales, eso es una virtud.
