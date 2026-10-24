import { createServer } from "node:http";
import { createConnection } from "node:net";

export const SCRIPT_TIMEOUT_MS = 240000;

export const reserveTcpPort = () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolvePort(address.port);
    });
  });
});

export class MarionetteClient {
  static async connect(port) {
    if (!Number.isInteger(port) || port <= 0) throw new Error("Marionette port must be explicit");
    const socket = await connectWithRetry(port);
    const client = new MarionetteClient(socket);
    await client.readPacket();
    return client;
  }

  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.nextId = 0;
  }

  async newSession() {
    await this.command("WebDriver:NewSession", { capabilities: { alwaysMatch: {} } });
  }

  async setChromeContext() {
    await this.command("Marionette:SetContext", { value: "chrome" });
  }

  async setScriptTimeout(ms = SCRIPT_TIMEOUT_MS) {
    await this.command("WebDriver:SetTimeouts", { script: ms });
  }

  async execute(script) {
    return await this.command("WebDriver:ExecuteScript", { script, args: [] });
  }

  async executeAsync(script) {
    return await this.command("WebDriver:ExecuteAsyncScript", { script, args: [] });
  }

  async command(name, params = {}) {
    this.nextId += 1;
    await this.writePacket([0, this.nextId, name, params]);
    const packet = await this.readPacket();
    const error = packet[2];
    if (error) throw new Error(`${name}: ${error.message || JSON.stringify(error)}`);
    return packet[3] && Object.hasOwn(packet[3], "value") ? packet[3].value : packet[3];
  }

  close() {
    this.socket.destroy();
  }

  async writePacket(payload) {
    const data = JSON.stringify(payload);
    this.socket.write(`${Buffer.byteLength(data)}:${data}`);
  }

  async readPacket() {
    while (true) {
      const packet = this.tryReadBufferedPacket();
      if (packet) return packet;
      const chunk = await this.readSocketChunk();
      this.buffer = Buffer.concat([this.buffer, chunk]);
    }
  }

  tryReadBufferedPacket() {
    const colon = this.buffer.indexOf(58);
    if (colon < 0) return null;
    const length = Number.parseInt(this.buffer.subarray(0, colon).toString("utf8"), 10);
    const start = colon + 1;
    const end = start + length;
    if (this.buffer.length < end) return null;
    const data = this.buffer.subarray(start, end).toString("utf8");
    this.buffer = this.buffer.subarray(end);
    return JSON.parse(data);
  }

  readSocketChunk() {
    return new Promise((resolveChunk, reject) => {
      const onData = (data) => {
        this.socket.off("error", onError);
        resolveChunk(data);
      };
      const onError = (error) => {
        this.socket.off("data", onData);
        reject(error);
      };
      this.socket.once("data", onData);
      this.socket.once("error", onError);
    });
  }
}

const connectWithRetry = async (port) => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      return await connectSocket(port);
    } catch (error) {
      await delay(250);
    }
  }
  throw new Error(`Marionette did not start on port ${port}`);
};

const connectSocket = (port) => new Promise((resolveSocket, reject) => {
  const socket = createConnection({ host: "127.0.0.1", port }, () => resolveSocket(socket));
  socket.once("error", reject);
});

const delay = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
