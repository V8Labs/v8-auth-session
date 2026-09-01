/**
 * v8-auth-session — llavero de sesión del ecosistema V8 para el NAVEGADOR.
 *
 * Gemelo cliente de `V8Labs/v8-auth-jwt` (que hace lo mismo del lado servidor).
 * Se importa fijado por SHA, nunca por tag — un tag se puede mover, y en un módulo
 * que decide si una credencial vale, esa comodidad no paga la superficie.
 *
 * Uso típico:
 *
 *     import { crearLlavero } from 'v8-auth-session';
 *     import { createClient } from '@supabase/supabase-js';
 *
 *     export const llavero = crearLlavero({ storageKey: 'v8auth' });
 *
 *     export const supabase = createClient(url, anonKey, {
 *       auth: {
 *         storage: llavero.storage,
 *         storageKey: llavero.nombres.sesion,
 *         persistSession: true,
 *         autoRefreshToken: true,
 *         detectSessionInUrl: true,
 *         flowType: 'pkce',
 *       },
 *       global: { fetch: llavero.fetch },   // ⚠ NO opcional — ver llavero.ts
 *     });
 */
export { crearLlavero } from './llavero';
export type { Llavero, LlaveroOpts, EdadSesion, Almacen, Reloj } from './llavero';
