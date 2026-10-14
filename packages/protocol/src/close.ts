/**
 * WebSocket close code sent to everyone in a room when its host leaves.
 * Clients must not reconnect on it: the session is over.
 */
export const ROOM_CLOSED = 4001

/**
 * WebSocket close code for a client that speaks an older protocol version
 * than the server. Clients must not reconnect on it: the client has to be
 * updated (or the page reloaded) first.
 */
export const CLIENT_OUTDATED = 4002

/**
 * WebSocket close code for a client that speaks a newer protocol version than
 * the server. Clients must not reconnect on it: the server has to be updated.
 */
export const SERVER_OUTDATED = 4003

/**
 * WebSocket close code sent to a guest who tries to join a room that already
 * has as many guests as the relay allows. Clients must not reconnect on it by
 * themselves: the room stays full until someone leaves.
 */
export const ROOM_FULL = 4004

/**
 * WebSocket close code for a connection the relay turns away because too many
 * came from the same network just now. Clients reconnect, but wait longer
 * than after a dropped connection.
 */
export const RELAY_BUSY = 4005

/**
 * WebSocket close code for a connection to a relay closed for maintenance.
 * Clients must not reconnect on it by themselves: whoever was editing decides
 * whether to pick the session up again once the relay is back.
 */
export const RELAY_MAINTENANCE = 4006

/**
 * WebSocket close code (the standard 1009) the relay sends a connection
 * whose frame is over MAX_FRAME_BYTES. Clients must not reconnect on it:
 * they would send the same frame again.
 */
export const MESSAGE_TOO_BIG = 1009
