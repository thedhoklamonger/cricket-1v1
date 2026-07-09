# Cricket Versus Online Event Contract

The server is authoritative. Clients render snapshots and send player actions.

## Client To Server

`room:create`

Payload: `{ playerName, settings }`

Creates a room, makes the sender host, joins the socket to the room, and returns `{ roomId, playerId }`.
The response also includes `playerKey`, a private reconnect key that the browser stores for this room.

`room:join`

Payload: `{ roomId, playerName, playerId?, playerKey? }`

Adds a player to a lobby room and returns `{ roomId, playerId, playerKey }`. If `playerId` and `playerKey` match an existing player, the socket reclaims that seat even after refresh or reconnect. If a saved room has already started, the same event can also reconnect an existing disconnected player when `playerName` matches their original name.

`room:updateSettings`

Payload: `{ settings }`

Host-only. Updates lobby settings before the draft starts.

`game:start`

Payload: `{}`

Host-only. Locks the lobby, builds teams, and starts the snake draft.

`draft:spin`

Payload: `{ skip }`

Active-player only. Draws a country and decade. If `skip` is true, consumes one skip from the active team.

`draft:pick`

Payload: `{ cardId, slot }`

Active-player only. Drafts a card into a legal batting slot, advances the snake draft, and clears the draw.

`match:startNext`

Payload: `{}`

Starts the next pending fixture as a live server simulation.

`match:setSpeed`

Payload: `{ speed }`

Sets live match speed to `1`, `2`, or `4`.

`match:skipToEnd`

Payload: `{}`

Finishes the running match immediately. If no match is running, completes the next pending fixture instantly.

`room:snapshot`

Payload: `{}`

Requests a fresh personalized room snapshot.

## Server To Client

`room:update`

Payload: personalized room snapshot.

Includes lobby players, settings, draft state, current draw, teams, available cards for the active draw, fixtures, standings, and viewer permissions.

`room:error`

Payload: `{ message }`

Human-readable validation error.

## Snapshot Notes

- Only the server mutates room state.
- `playerKey` is never included in `room:update`; it is only returned to the joining browser.
- `viewer.isHost` controls settings and start-game UI.
- `viewer.isActive` controls draft buttons.
- `pool[].slots` is computed by the server and is the only set of legal slots the client should display.
- The server revalidates every action even when the client hides illegal controls.
