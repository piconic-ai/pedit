/**
 * WebSocket close code sent to everyone in a room when its host leaves.
 * Clients must not reconnect on it: the session is over.
 */
export const ROOM_CLOSED = 4001

/**
 * WebSocket close code a host sends when it ends the session on purpose, as
 * on Ctrl+C. The relay then closes the room at once (with ROOM_CLOSED for
 * everyone else), where a host that drops gets a grace period to come back.
 */
export const HOST_LEFT = 4008

/**
 * Text frames the relay itself sends guests, the only frames not from a peer
 * and not encrypted: the host dropped and the relay waits for it to come back
 * (HOST_AWAY), or it came back (HOST_BACK). Guests do not edit while the host
 * is away: nobody would save what they wrote.
 */
export const HOST_AWAY = 'host away'
export const HOST_BACK = 'host back'

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
 * WebSocket close code sent to everyone in a room that reached the relay's
 * time limit, counted from its host's first connection, and to anyone who
 * connects to it afterwards. Clients must not reconnect on it: the room ID is
 * never reopened; the host starts a new room.
 */
export const ROOM_EXPIRED = 4007

const EXPIRED = /^the room reached its time limit of (\d{1,10}) seconds$/

/** The close reason that tells clients how long the relay lets a room last. */
export function expiredReason(seconds: number): string {
  return `the room reached its time limit of ${seconds} seconds`
}

/** The limit in seconds a ROOM_EXPIRED reason names, or undefined if it names none. */
export function parseExpiredReason(reason: string | undefined): number | undefined {
  const match = EXPIRED.exec(reason ?? '')
  const seconds = match ? Number(match[1]) : 0
  return seconds > 0 ? seconds : undefined
}

/**
 * WebSocket close code (the standard 1009) the relay sends a connection
 * whose frame is over MAX_FRAME_BYTES. Clients must not reconnect on it:
 * they would send the same frame again.
 */
export const MESSAGE_TOO_BIG = 1009
