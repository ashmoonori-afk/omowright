// CDP peer whose failures are triggered by commands, never by elapsed time.
import { createReadStream, createWriteStream } from "node:fs";
import { Socket } from "node:net";

const input = typeof Bun === "undefined"
  ? new Socket({ fd: 3, readable: true, writable: false })
  : createReadStream(null, { fd: 3 });
const output = createWriteStream(null, { fd: 4 });
const write = message => output.write(JSON.stringify(message) + "\0");
const held = new Map();
let buffer = Buffer.alloc(0);
process.on("SIGTERM", () => process.exit(0));

input.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  let index;
  while ((index = buffer.indexOf(0)) !== -1) {
    const message = JSON.parse(buffer.subarray(0, index).toString("utf8"));
    buffer = buffer.subarray(index + 1);
    const { id, method, params, sessionId } = message;
    switch (method) {
      case "Browser.close":
        output.end(JSON.stringify({ id, result: {} }) + "\0", () => process.exit(0));
        break;
      case "Target.attachToTarget":
        write({ id, result: { sessionId: `session-${params.targetId}` } });
        break;
      case "Fixture.silent":
        break;
      case "Fixture.traffic":
        write({ method: "Fixture.observed", params: {} });
        break;
      case "Fixture.malformed":
        output.write("{not-json}\0");
        break;
      case "Fixture.hold":
        held.set(sessionId, id);
        write({ method: "Fixture.held", params: { sessionId } });
        break;
      case "Fixture.release":
        write({ id: held.get(params.sessionId), result: { released: true } });
        held.delete(params.sessionId);
        write({ id, result: {} });
        break;
      case "Fixture.end":
        output.end();
        break;
      case "Fixture.detach":
        write({ method: "Target.detachedFromTarget", params: { sessionId: params.sessionId } });
        write({ id, result: {} });
        break;
      case "Fixture.crash":
        write({ method: "Inspector.targetCrashed", params: {}, sessionId: params.sessionId });
        write({ id, result: {} });
        break;
      default:
        write({ id, result: method === "Browser.getVersion" ? { product: "PipeFixture/1.0" } : {} });
    }
  }
});
input.on("end", () => process.exit(0));
