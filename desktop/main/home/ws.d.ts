/** The small ws 8.21.3 surface used by the native-only Home transport. */
declare module 'ws' {
  import type { ClientRequest, IncomingMessage } from 'node:http';
  import type { SecureContextOptions } from 'node:tls';
  export class WebSocketServer {
    constructor(options: { server: import('node:http').Server });
    on(event: 'connection', listener: (socket: WebSocket, request: IncomingMessage) => void): this;
    close(callback?: (error?: Error) => void): void;
  }
  export default class WebSocket {
    static OPEN: number;
    readyState: number;
    constructor(url: string | URL, options?: SecureContextOptions & { headers?: Record<string, string>; handshakeTimeout?: number; maxPayload?: number; followRedirects?: boolean; perMessageDeflate?: boolean; rejectUnauthorized?: boolean });
    on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): this;
    on(event: 'open' | 'close' | 'error', listener: (...args: any[]) => void): this;
    on(event: 'unexpected-response', listener: (request: ClientRequest, response: IncomingMessage) => void): this;
    send(data: string, callback?: (error?: Error) => void): void;
    close(code?: number): void;
    terminate(): void;
  }
}
