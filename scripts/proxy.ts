import http from "node:http";
import { APIError, TypeSafeClient } from "@typesafe-ai/sdk";

const port = Number(process.argv[2] ?? 8787);
const client = new TypeSafeClient({ timeout: 120_000, logLevel: "info" });

const server = http.createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(JSON.stringify(payload));
  };
  try {
    if (request.method === "POST" && request.url === "/v1/systemone") {
      const { data, requestId } = await client.systemOne(JSON.parse(body)).withResponse();
      console.log(`systemone ${requestId ?? ""} (${Object.keys(data.answers).length} answers, ${data.usage.input_tokens} tokens, ${data.model})`);
      send(200, data, { "x-typesafe-request-id": requestId ?? "" });
      return;
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      const models = await client.models.list();
      send(200, { models });
      return;
    }
    send(404, { error: { message: `no route for ${request.method} ${request.url}`, type: "not_found_error" } });
  } catch (error) {
    if (error instanceof APIError) {
      send(error.status, error.body ?? { error: error.message });
      return;
    }
    send(500, { error: { message: error instanceof Error ? error.message : String(error), type: "proxy_error" } });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`proxy listening on http://127.0.0.1:${port} (TypeSafe-compatible; forwards to ${client.baseURL} with the key from the environment)`);
});
