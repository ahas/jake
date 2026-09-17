# jake tunnel protocol

This is the canonical statement of the frames that cross the tunnel. The wire-protocol module
answers to it.

## Shape of the connection

- The agent dials the hub and holds one connection open. Frames travel in both directions over that
  one connection — the protocol is a symmetric stream of frames, not a request/response exchange.
- Every frame is a JSON object sent as text. Every frame carries a `type` naming its kind and a `v`
  giving the protocol version. A receiver that sees a version other than the one it speaks refuses
  the frame rather than guessing at it.
- Binary payloads — a screenshot PNG, a fetched body, a chunk of command output — ride inside a
  frame as base64, alongside a declared decoded byte length. The length is declared so a receiver
  can refuse an oversized payload by reading one integer, before it allocates the decoded buffer.
  Each side carries its own size cap in configuration and applies it while decoding.

## Byte payloads

- An **encoded-bytes** value is a declared byte length together with the base64 of exactly that many
  bytes. Command output chunks carry one.
- An **encoded-blob** value is an encoded-bytes value that also names the media type of the bytes. A
  capability result carries one when it returns binary output.
- Decoding a byte payload re-checks the size cap and verifies that the decoded length equals the
  declared one; a mismatch is rejected as a malformed field.

## Frames

Connection handshake:

- **hello** — agent to hub, first on a fresh connection: the agent's identity, its version, and the
  list of capabilities this build offers. The list is just names; the protocol does not know what
  they mean.
- **welcome** — hub to agent, accepting the hello and naming the hub's version.
- **reject** — hub to agent, refusing the hello with a stated reason.

Command execution (streaming):

- **exec** — hub to agent: run a command. It carries a caller-chosen id that every frame the run
  emits will echo, the shell to run it through, the command text, an optional working directory, an
  environment overlay, and, for WSL, an optional distribution.
- **stdout** / **stderr** — agent to hub: one chunk of a run's output, carrying the run's id, a
  sequence number that orders the chunks, and the chunk bytes. Chunks are emitted as output arrives,
  not held until the run ends.
- **exit** — agent to hub: the run has ended, carrying its id, its exit code, its signal if it was
  killed, and whether the end came from a cancel rather than a natural finish.
- **cancel** — hub to agent: stop the run with this id, ending its whole process tree.

Capabilities (non-streaming):

- **call** — hub to agent: invoke a capability by name, with a caller-chosen id and free-form
  parameters. Screenshot, fetch, and the browser methods are all calls; the protocol carries the
  name and parameters without knowing them.
- **result** — agent to hub: a call succeeded, carrying its id, a free-form value, and an optional
  blob for binary output.
- **error** — agent to hub, or hub to agent: a call or a run request failed, carrying the id it
  answers, a short code, and a message.

Liveness:

- **ping** / **pong** — either side: a probe carrying the sender's clock, and its echo. The hub
  probes on an interval and treats a run of missed answers as a dead connection rather than trusting
  the socket's own liveness.

## Decoding outcomes

Decoding a received string yields either a validated frame or a named rejection. The rejection names
which of these went wrong, so a caller can tell them apart:

- the string was not JSON;
- the JSON was not an object;
- the object had no string type;
- the type was not one of the known kinds;
- the version was not the one this side speaks;
- a required field was missing or the wrong type;
- a declared payload exceeded the size cap.

Unknown extra fields on an otherwise-valid frame are ignored, and the validated frame carries only
the fields its kind defines.
