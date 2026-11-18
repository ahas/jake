# jake tunnel protocol

This is the canonical statement of the frames that cross the tunnel. The wire-protocol module
answers to it.

## Shape of the connection

- The agent dials the hub and holds one connection open. Frames travel in both directions over that
  one connection — the protocol is a symmetric stream of frames, not a request/response exchange.
- Every frame is a JSON object sent as text. Every frame carries a `type` naming its kind and a `v`
  giving the protocol version. A receiver that sees a version other than the one it speaks refuses
  the frame rather than guessing at it.
- Binary payloads — a chunk of command output, a chunk of a file transfer, or a piece of a byte
  stream — ride inside a frame as
  base64, alongside a declared decoded byte length. The length is declared so a receiver can refuse an
  oversized payload by reading one integer, before it allocates the decoded buffer. Each side carries
  its own size cap in configuration and applies it while decoding.

## Byte payloads

- An **encoded-bytes** value is a declared byte length together with the base64 of exactly that many
  bytes. Command output chunks, file-transfer chunks and byte-stream pieces carry one.
- Decoding a byte payload re-checks the size cap and verifies that the decoded length equals the
  declared one; a mismatch is rejected as a malformed field.
- The two sides do not negotiate their caps on the wire, so a frame that exceeds the receiver's cap is
  refused at decode and dropped while the connection stays open. A sender that must stay under both
  caps — a file transfer — therefore fixes its chunk size well below the smaller cap a deployment
  would set, rather than relying on the receiver to accept a large frame.

## Frames

Connection handshake:

- **hello** — agent to hub, first on a fresh connection: the agent's identity, its version, and its
  capabilities: `exec:<shell>` for each shell this build can run, `transfer`, and `stream:<port>`
  for each local port the agent lets a byte stream reach. The shell names are just names; the
  protocol does not know what they mean.
- **welcome** — hub to agent, accepting the hello and naming the hub's version.
- **reject** — hub to agent, refusing the hello with a stated reason.

Command execution (streaming):

- **exec** — hub to agent: run a command. It carries a caller-chosen id that every frame the run
  emits will echo, the shell to run it through, the command text, an optional working directory, an
  environment overlay, and, for WSL, an optional distribution. The named shell is meant to be one of
  those the hello list advertised; on a Windows host these are PowerShell and WSL, on a Linux or WSL
  host a Linux shell. A name the host has no shell for is run in the host's own shell, not refused.
  The command text reaches the shell as written, with no other shell expanding it first, so a caller
  writes it as it would at that shell's own prompt. The command text is bounded by the same size cap
  as a byte payload, so an embedded-content command cannot slip past the cap that guards every chunk.
- **stdout** / **stderr** — agent to hub: one chunk of a run's output, carrying the run's id, a
  sequence number that orders the chunks, and the chunk bytes. Chunks are emitted as output arrives,
  not held until the run ends.
- **exit** — agent to hub: the run has ended, carrying its id, its exit code, its signal if it was
  killed, and whether the end came from a cancel rather than a natural finish.
- **cancel** — hub to agent: stop the run with this id, ending its whole process tree.

- **error** — agent to hub, or hub to agent: a request failed — a spawn
  failure, a file-transfer failure such as a missing file, a permission denial, a full disk, or a
  content that did not verify, or a byte stream that could not be opened — carrying the id it
  answers, a short code, and a message.

File transfer (streaming):

- **transfer-begin** — opens a transfer: a caller-chosen id that every later frame of the transfer
  echoes, the direction (an upload writes a file on the machine, a download reads one from it), and
  the path on the machine. The side that will send the bytes also carries the total byte length and a
  content checksum. An upload's begin comes from the hub with the size and checksum up front; a
  download's begin comes from the hub as a request naming only the path, and the agent answers with
  its own begin carrying the size and checksum it is about to stream.
- **transfer-chunk** — one chunk of the content, carrying the transfer id, a sequence number that
  orders the chunks, and the chunk bytes as an encoded-bytes value. Chunk size is held well below the
  smaller of the two sides' payload caps, so no chunk is ever refused for exceeding a cap. The hub
  paces an upload's chunks to its socket: once the socket's unwritten backlog passes its limit the
  hub hands it nothing more of the transfer until that backlog has drained, so the hub never holds
  more of an upload than the backlog limit. The agent's socket holds whatever it is handed, so a
  download is sent unpaced.
- **transfer-end** — closes a transfer: the transfer id, the total bytes sent, and the content
  checksum. The receiver accepts the file only after the bytes it assembled match this declared total
  and checksum; a receiver that streamed an upload to a temporary path moves it into place atomically
  only once both match. A mismatch, a dropped chunk, or a file-system failure is answered with an
  **error** frame carrying the transfer id, so a partial transfer is never taken for a whole one.
  The error travels the other way as well: a hub that cannot finish sending an upload says so with an
  **error** frame naming it, and the agent discards the temporary file it was writing.

Byte streams:

- **stream-open** — hub to agent: open a TCP connection to a port on the agent's own machine,
  reached at `localhost`. It carries a caller-chosen id that every later frame of the stream echoes,
  and the port. The agent opens only a port its own configuration allows, the same ports its hello
  advertised as `stream:<port>`; any other is answered with an **error** frame coded
  `port-not-allowed`, and a connection the port refuses or does not accept in time is answered with
  one coded `connect-failed`.
- **stream-opened** — agent to hub: the connection is up and bytes may flow both ways.
- **stream-data** — either side: one piece of the stream's bytes, carrying the stream id, a sequence
  number that orders the pieces of that direction from zero, and the bytes as an encoded-bytes
  value. A piece is at most the stream chunk size, 64 KiB.
- **stream-ack** — either side: the receiver of a stream's bytes has handed this many more of them
  on to its own end — the TCP connection on the agent, the caller on the hub — carrying the stream id
  and the byte count.
- **stream-close** — either side: the stream is over in both directions, carrying the stream id and
  a short reason. It is not answered. The agent sends it when the port closes its connection or a
  write to it fails; the hub sends it when the caller goes away. Every piece sent before the close is
  still delivered: the receiver writes what it already holds of the stream to its own end and only then
  closes that end, so a target that answers and closes at once is heard in full. A close for a stream
  already over is ignored.

A stream is paced by a window. Each sender may have at most the stream window, 1 MiB, of a stream's
bytes sent and not yet acknowledged; once it reaches that, it sends nothing more of the stream until
an ack reopens the window by the count it carries. A receiver acknowledges in batches, once a
quarter of the window has been handed on since its last ack, so small interactive traffic is never
held waiting for one. The window is what bounds the memory a stream holds on either side, because a
receiver never holds more of a stream than the window, whatever the far end's speed. A piece out of
sequence, or one that takes the receiver past the window, is a fault: the receiver ends the stream
with a stream-close naming it.

A stream lives on the connection it was opened over. When that connection drops, every stream on it
is over on both sides, and nothing of a stream crosses to a later connection.

Streams back:

- **listen** — hub to agent: listen on a port of the agent's own loopback, carrying a hub-chosen id and
  the port. The agent listens only on a port its configuration allows, the ports its hello advertised
  as `listen:<port>`; any other is answered with an **error** frame coded `port-not-allowed`, and a port
  it cannot bind with one coded `bind-failed`. A listen for an id the agent already listens on is
  answered with listening at once, and the standing listen goes on undisturbed.
- **listening** — agent to hub: the port is listened on, carrying the listen's id.
- **unlisten** — hub to agent: stop listening, carrying the listen's id. Streams already accepted on it
  go on. The agent releases the port before it reads the next frame, so a listen that follows at once
  binds it again. It is not answered.
- **stream-accept** — agent to hub: a connection came in on a listened port. It carries an
  agent-chosen stream id and the listen's id. From here the stream is a byte stream like any other:
  stream-data, stream-ack and stream-close carry it both ways, each side paced by the window, and the
  agent may send its bytes at once. The hub joins it to the target it named for that listen; a target
  that cannot be reached is answered with a stream-close.

A listen lives on the connection it was asked over, as a stream does. When the connection drops the
agent stops listening; the hub asks again on the agent's next connection.

Departure:

- **leave** — hub to agent: uninstall jake from the machine and depart. It carries nothing beyond the
  envelope. On receiving it the agent stops whatever keeps it running — the guard on a Windows host,
  the service unit on a Linux host — removes its autostart registrations, deletes its executable,
  config, log, and data, and exits; it sends no reply, and the hub reads the departure from the
  connection dropping. The scheme it triggers is in docs/architecture.md.
- **leave** — hub to agent, in answer to a hello: an agent presenting a credential of its own name
  says hello under a name the hub has revoked. The hub sends the leave in place of the welcome,
  attaches nothing and closes the connection, and the agent departs as above whether or not it was
  ever welcomed. A socket that held a name gives it up first. An uninstaller's leave notice that
  meets this leave sends none of its own, since the hub has recorded the departure already.
- **leave** — agent to hub, after a welcome: this agent has been uninstalled by hand. Its uninstaller
  sends it through a short-lived connection of its own once the agent is stopped. The hub drops the
  connection and records the agent as departed; it sends no reply.
- Either way the hub records the agent as departed and no longer lists it as attached, until a hello
  under the same name arrives; a hello under a revoked name is answered with a leave again and
  leaves it departed.

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
- a declared payload — a byte chunk, a stream piece, or the exec command text — exceeded the size
  cap.

Unknown extra fields on an otherwise-valid frame are ignored, and the validated frame carries only
the fields its kind defines.
