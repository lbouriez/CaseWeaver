import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";

const issuer = process.env.CASEWEAVER_E2E_OIDC_ISSUER;
const clientId = process.env.CASEWEAVER_E2E_OIDC_CLIENT_ID;
const clientSecretFile = process.env.CASEWEAVER_E2E_OIDC_CLIENT_SECRET_FILE;
const certificateFile = process.env.CASEWEAVER_E2E_OIDC_CERTIFICATE_FILE;
const privateKeyFile = process.env.CASEWEAVER_E2E_OIDC_PRIVATE_KEY_FILE;
const port = Number(process.env.CASEWEAVER_E2E_OIDC_PORT ?? "9443");

if (
  issuer === undefined ||
  clientId === undefined ||
  clientSecretFile === undefined ||
  certificateFile === undefined ||
  privateKeyFile === undefined ||
  !Number.isInteger(port)
) {
  throw new Error("OIDC fixture configuration is incomplete.");
}

const clientSecret = readFileSync(clientSecretFile, "utf8").trim();
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwk = publicKey.export({ format: "jwk" });
const codes = new Map();

function base64Url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function idToken(input) {
  const header = base64Url({
    alg: "RS256",
    kid: "caseweaver-e2e-oidc",
    typ: "JWT",
  });
  const now = Math.floor(Date.now() / 1_000);
  const claims = base64Url({
    iss: issuer,
    sub: "caseweaver-e2e-oidc-administrator",
    aud: clientId,
    exp: now + 300,
    iat: now,
    nonce: input.nonce,
    name: "CaseWeaver E2E OIDC Administrator",
  });
  const signed = `${header}.${claims}`;
  return `${signed}.${sign("RSA-SHA256", Buffer.from(signed), privateKey).toString("base64url")}`;
}

function respond(response, status, body, contentType = "application/json") {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": contentType,
  });
  response.end(body);
}

const server = createServer(
  {
    cert: readFileSync(certificateFile),
    key: readFileSync(privateKeyFile),
    minVersion: "TLSv1.2",
  },
  async (request, response) => {
    const url = new URL(request.url ?? "/", issuer);
    const basePath = new URL(issuer).pathname.replace(/\/$/u, "");
    if (
      request.method === "GET" &&
      url.pathname === `${basePath}/.well-known/openid-configuration`
    ) {
      respond(
        response,
        200,
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        }),
      );
      return;
    }
    if (request.method === "GET" && url.pathname === `${basePath}/jwks`) {
      respond(
        response,
        200,
        JSON.stringify({
          keys: [
            { ...jwk, kid: "caseweaver-e2e-oidc", use: "sig", alg: "RS256" },
          ],
        }),
      );
      return;
    }
    if (request.method === "GET" && url.pathname === `${basePath}/authorize`) {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const nonce = url.searchParams.get("nonce");
      const challenge = url.searchParams.get("code_challenge");
      if (
        url.searchParams.get("client_id") !== clientId ||
        url.searchParams.get("response_type") !== "code" ||
        url.searchParams.get("code_challenge_method") !== "S256" ||
        redirectUri === null ||
        state === null ||
        nonce === null ||
        challenge === null
      ) {
        respond(response, 400, JSON.stringify({ error: "invalid_request" }));
        return;
      }
      const code = randomUUID();
      codes.set(code, { redirectUri, nonce, challenge });
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", state);
      response.writeHead(302, {
        location: callback.toString(),
        "cache-control": "no-store",
      });
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === `${basePath}/token`) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const authorization = request.headers.authorization;
      const expectedAuthorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
      const record = codes.get(form.get("code"));
      const verifier = form.get("code_verifier");
      const challenge =
        verifier === null
          ? undefined
          : createHash("sha256").update(verifier).digest("base64url");
      if (
        authorization !== expectedAuthorization ||
        form.get("grant_type") !== "authorization_code" ||
        form.get("client_id") !== clientId ||
        record === undefined ||
        form.get("redirect_uri") !== record.redirectUri ||
        challenge !== record.challenge
      ) {
        respond(response, 400, JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      codes.delete(form.get("code"));
      respond(
        response,
        200,
        JSON.stringify({ token_type: "Bearer", id_token: idToken(record) }),
      );
      return;
    }
    respond(response, 404, JSON.stringify({ error: "not_found" }));
  },
);

server.listen(port, "0.0.0.0");
