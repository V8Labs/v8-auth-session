# Dominio

Este repo es una **librería del dominio `auth`**, no la casa de un agente.

## Por qué NO tiene `.agent-name`

Lo tuvo hasta el 2026-09-06 y fue un error mío al crearlo. `.agent-name` declara
**qué agente ES una sesión abierta acá**, y el reconciliador (ops/0068) lo lee
como «este repo es el hogar de ese agente». Con tres repos declarando `auth`
—`core_v8_auth` y estas dos librerías— reportó colisión cinco corridas seguidas,
del 02 al 06-sep.

**El dato no estaba mal en su intención** (las tres son del dominio `auth`), pero
sí en lo que ese archivo significa: el hogar del agente es UNO.

    core_v8_auth      ← la casa de `auth`. Ahí se trabaja, ahí llega el inbox.
    v8-auth-session   ← librería (llavero del navegador)
    v8-auth-service   ← librería (identidad no humana)

## Si vas a trabajar en este repo

Abrí la sesión desde `core_v8_auth` y editá esta librería desde ahí. No le
vuelvas a poner `.agent-name`: no arregla nada y devuelve la colisión.
