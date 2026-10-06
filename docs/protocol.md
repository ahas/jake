# jake tunnel protocol

This is the canonical statement of the frames that cross the tunnel. The wire-protocol module
answers to it.

## Shape of the connection

- The agent dials the hub and holds one connection open. Frames travel in both directions over that
  one connection — the protocol is a symmetric stream of frames, not a request/response exchange.
- Every frame is a JSON object sent as text. Every frame carries a `type` naming its kind and a `v`
  giving the protocol version. A receiver that sees a version other than the one it speaks refuses
  the frame rather than guessing at it.
- Binary payloads — a chunk of command output, or a chunk of a file transfer — ride inside a frame as
  base64, alongside a declared decoded byte length. The length is declared so a receiver can refuse an
  oversized payload by reading one integer, before it allocates the decoded buffer. Each side carries
  its own size cap in configuration and applies it while decoding.

## Byte payloads

- An **encoded-bytes** value is a declared byte length together with the base64 of exactly that many
  bytes. Command output chunks and file-transfer chunks carry one.
- Decoding a byte payload re-checks the size cap and verifies that the decoded length equals the
  declared one; a mismatch is rejected as a malformed field.
- The two sides do not negotiate their caps on the wire, so a frame that exceeds the receiver's cap is
  refused at decode and dropped while the connection stays open. A sender that must stay under both
  caps — a file transfer — therefore fixes its chunk size well below the smaller cap a deployment
  would set, rather than relying on the receiver to accept a large frame.

## Frames

Connection handshake:

- **hello** — agent to hub, first on a fresh connection: the agent's identity, its version, and the
  list of shells this build can run. The list is just names; the protocol does not know what they
  mean.
- **welcome** — hub to agent, accepting the hello and naming the hub's version.
- **reject** — hub to agent, refusing the hello with a stated reason.

Command execution (streaming):

- **exec** — hub to agent: run a command. It carries a caller-chosen id that every frame the run
  emits will echo, the shell to run it through, the command text, an optional working directory, an
  environment overlay, and, for WSL, an optional distribution. The named shell is meant to be one of
  those the hello list advertised; on a Windows host these are PowerShell and WSL, on a Linux or WSL
  host a Linux shell. A name the host has no shell for is run in the host's own shell, not refused. The command text is bounded by the same size cap as a byte payload, so an
  embedded-content command cannot slip past the cap that guards every chunk.
- **stdout** / **stderr** — agent to hub: one chunk of a run's output, carrying the run's id, a
  sequence number that orders the chunks, and the chunk bytes. Chunks are emitted as output arrives,
  not held until the run ends.
- **exit** — agent to hub: the run has ended, carrying its id, its exit code, its signal if it was
  killed, and whether the end came from a cancel rather than a natural finish.
- **cancel** — hub to agent: stop the run with this id, ending its whole process tree.

- **error** — agent to hub, or hub to agent: a request failed — a spawn
  failure, or a file-transfer failure such as a missing file, a permission denial, a full disk, or a
  content that did not verify — carrying the id it answers, a short code, and a message.

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

Departure:

- **leave** — hub to agent: uninstall jake from the machine and depart. It carries nothing beyond the
  envelope. On receiving it the agent stops whatever keeps it running — the guard on a Windows host,
  the service unit on a Linux host — removes its autostart registrations, deletes its executable,
  config, log, and data, and exits; it sends no reply, and the hub reads the departure from the
  connection dropping. The scheme it triggers is in docs/architecture.md.
- **leave** — agent to hub, after a welcome: this agent has been uninstalled by hand. Its uninstaller
  sends it through a short-lived connection of its own once the agent is stopped. The hub drops the
  connection and records the agent as departed; it sends no reply.
- Either way the hub records the agent as departed and no longer lists it as attached, until a hello
  under the same name arrives.

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
- a declared payload — a byte chunk, or the exec command text — exceeded the size cap.

Unknown extra fields on an otherwise-valid frame are ignored, and the validated frame carries only
the fields its kind defines.
