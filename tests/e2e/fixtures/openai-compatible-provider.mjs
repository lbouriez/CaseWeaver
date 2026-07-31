import { readFile } from "node:fs/promises";
import https from "node:https";

const port = Number(process.env.CASEWEAVER_E2E_PROVIDER_PORT ?? "8443");
const credential = process.env.CASEWEAVER_E2E_OPENAI_COMPATIBLE_KEY;
const model = "caseweaver-e2e-embedding-1536";
const dimensions = 1536;

if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error("The E2E provider port is invalid.");
}
if (credential === undefined || credential.length === 0) {
  throw new Error("The E2E provider credential is missing.");
}

function writeJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-request-id": "caseweaver-e2e-provider-request",
  });
  response.end(JSON.stringify(value));
}

function authorized(request) {
  return request.headers.authorization === `Bearer ${credential}`;
}

async function requestJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 100_000) throw new Error("request-too-large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function vector(seed) {
  return Array.from({ length: dimensions }, (_, index) =>
    index === seed % dimensions ? 1 : 0,
  );
}

const [key, cert] = await Promise.all([
  readFile("/certificates/server-key.pem"),
  readFile("/certificates/server.pem"),
]);

const server = https.createServer({ key, cert }, async (request, response) => {
  const pathname = new URL(request.url ?? "/", "https://e2e-openai-provider")
    .pathname;
  if (request.method === "GET" && pathname === "/health/ready") {
    response.writeHead(200, { "cache-control": "no-store" });
    response.end();
    return;
  }
  if (!authorized(request)) {
    writeJson(response, 401, { error: { message: "unauthorized" } });
    return;
  }
  if (request.method === "GET" && pathname === "/v1/models") {
    writeJson(response, 200, {
      object: "list",
      data: [
        {
          id: model,
          object: "model",
          architecture: { output_modalities: ["embeddings"] },
          context_length: 8192,
        },
      ],
    });
    return;
  }
  if (request.method === "POST" && pathname === "/v1/embeddings") {
    try {
      const body = await requestJson(request);
      if (
        body === null ||
        typeof body !== "object" ||
        body.model !== model ||
        !Array.isArray(body.input) ||
        body.input.length === 0 ||
        body.input.some((input) => typeof input !== "string")
      ) {
        writeJson(response, 400, { error: { message: "invalid request" } });
        return;
      }
      writeJson(response, 200, {
        object: "list",
        model,
        data: body.input.map((_, index) => ({
          object: "embedding",
          index,
          embedding: vector(index),
        })),
        usage: {
          prompt_tokens: body.input.length,
          total_tokens: body.input.length,
        },
      });
    } catch {
      writeJson(response, 400, { error: { message: "invalid request" } });
    }
    return;
  }
  writeJson(response, 404, { error: { message: "not found" } });
});

server.listen(port, "0.0.0.0");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
