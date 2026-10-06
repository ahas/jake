// A TCP server standing in for the port a byte stream reaches: it echoes or records what arrives.

import type { Socket, TCPSocketListener } from "bun";

/** One local TCP port: what each connection sent it, and the connections it holds. */
export class StandInPort {
  readonly received: Buffer[] = [];
  accepted = 0;
  closed = 0;
  private readonly server: TCPSocketListener<undefined>;
  private socket: Socket<undefined> | null = null;
  private pending: Buffer = Buffer.alloc(0);

  /** An echoing port writes every byte it receives straight back. */
  constructor(echo = false) {
    this.server = Bun.listen<undefined>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: (socket) => {
          this.socket = socket;
          this.accepted += 1;
        },
        data: (_socket, data) => {
          this.received.push(Buffer.from(data));
          if (echo) this.write(data);
        },
        drain: () => this.flush(),
        close: (socket) => {
          if (this.socket === socket) this.socket = null;
          this.closed += 1;
        },
      },
    });
  }

  get port(): number {
    return this.server.port;
  }

  /** Everything received so far, as one buffer. */
  get bytes(): Buffer {
    return Buffer.concat(this.received);
  }

  /** Write to the open connection, holding what the socket does not take until it drains. */
  write(data: Uint8Array): void {
    this.pending = Buffer.concat([this.pending, Buffer.from(data)]);
    this.flush();
  }

  /** Close the open connection, as a program at the port ending its session does. */
  end(): void {
    this.socket?.end();
  }

  private flush(): void {
    if (this.socket === null || this.pending.length === 0) return;
    const written = this.socket.write(this.pending);
    this.pending = this.pending.subarray(Math.max(written, 0));
  }

  stop(): void {
    this.server.stop(true);
  }
}
