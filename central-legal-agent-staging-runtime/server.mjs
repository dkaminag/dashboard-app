import http from "node:http";

import {
  buildSyntheticStagingRequest,
  createSyntheticMatterResolver,
  executeLegalAgentStagingBridge,
} from "../dashboard-backend/central-legal-agent-staging-bridge.mjs";

const PORT = Number(process.env.PORT || 8080);
const ENVIRONMENT = String(process.env.CJ_LEGAL_AGENT_STAGING_ENV || "").trim().toUpperCase();
const DATA_MODE = String(process.env.CJ_LEGAL_AGENT_STAGING_DATA_MODE || "").trim().toUpperCase();
const ENABLED = String(process.env.CJ_LEGAL_AGENT_STAGING_ENABLED || "").trim().toLowerCase() === "true";
const READY = ENABLED && ENVIRONMENT === "STAGING" && DATA_MODE === "SYNTHETIC";

const auditEvents = [];
let lastStagingEvidence = null;

function headers() {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  };
}

function send(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { ...headers(), "content-length": body.length });
  res.end(body);
}

function rejectBody(req) {
  const raw = req.headers["content-length"];
  if (raw == null) return false;
  const size = Number(raw);
  return Number.isFinite(size) && size > 0;
}

const auditSink = {
  async record(event) {
    auditEvents.push(structuredClone(event));
    while (auditEvents.length > 16) auditEvents.shift();
  },
};

const transport = {
  async send(payload) {
    if (payload.webSearch !== false) throw new Error("STAGING_WEB_SEARCH_MUST_BE_DISABLED");
    if (!Array.isArray(payload.files) || payload.files.length !== 0) throw new Error("STAGING_FILES_MUST_BE_EMPTY");
    if (!String(payload.message || "").includes("ESTRITAMENTE SINTETICO")) {
      throw new Error("STAGING_SYNTHETIC_MARKER_REQUIRED");
    }
    return {
      answer:
        "Resposta estritamente sintetica do runtime de staging. AUTHORITY_CHECK_REQUIRED para qualquer autoridade legal atual nao fornecida.",
      citations: [],
      provider: "synthetic-isolated-runtime",
      model: "deterministic-stub",
    };
  },
};

async function runSynthetic() {
  const request = buildSyntheticStagingRequest();
  const result = await executeLegalAgentStagingBridge({
    request,
    operator: {
      authenticated: true,
      ref: "central:operator:staging-synthetic-lawyer",
      role: "lawyer",
    },
    authorization: {
      ref: request.authorization_ref,
      capabilities: [...request.requested_capabilities],
    },
    featureFlagEnabled: true,
    resolver: createSyntheticMatterResolver(),
    auditSink,
    transport,
  });
  lastStagingEvidence = structuredClone(result.stagingEvidence);
  return result;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://local.invalid");

  if (req.method === "GET" && url.pathname === "/health") {
    send(res, 200, {
      ok: true,
      service: "central-legal-agent-isolated-staging",
      environment: ENVIRONMENT || "UNSET",
      dataMode: DATA_MODE || "UNSET",
      enabled: ENABLED,
      ready: READY,
      identityMode: "SYNTHETIC_FIXTURE",
      realMatterAuthority: false,
      productionAuthority: false,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/ready") {
    if (!READY) {
      send(res, 503, {
        ok: false,
        error: "STAGING_NOT_READY",
        realMatterAuthority: false,
        productionAuthority: false,
      });
      return;
    }
    send(res, 200, {
      ok: true,
      environment: "STAGING",
      dataMode: "SYNTHETIC",
      identityMode: "SYNTHETIC_FIXTURE",
      realMatterAuthority: false,
      productionAuthority: false,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/staging/synthetic") {
    if (!READY) {
      send(res, 503, { error: "STAGING_NOT_READY" });
      return;
    }
    if (rejectBody(req)) {
      send(res, 400, { error: "STAGING_ARBITRARY_INPUT_BLOCKED" });
      return;
    }
    try {
      const result = await runSynthetic();
      send(res, 200, {
        ok: result.ok === true,
        requestDigest: result.requestDigest,
        matterRefDigest: result.matterRefDigest,
        sourceRefsDigest: result.sourceRefsDigest,
        answer: result.answer,
        citations: result.citations,
        auditEventCount: auditEvents.length,
        stagingEvidence: result.stagingEvidence,
        realMatterAuthority: false,
        productionAuthority: false,
      });
    } catch (error) {
      send(res, 500, {
        error: error?.code || error?.message || "STAGING_SYNTHETIC_FAILED",
        realMatterAuthority: false,
        productionAuthority: false,
      });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/staging/evidence") {
    send(res, 200, {
      eventCount: auditEvents.length,
      events: auditEvents.map((event) => ({
        event: event.event,
        requestDigest: event.requestDigest ?? null,
        matterRefDigest: event.matterRefDigest ?? null,
        sourceRefsDigest: event.sourceRefsDigest ?? null,
        answerDigest: event.answerDigest ?? null,
        operatorRole: event.operatorRole ?? null,
        outcome: event.outcome ?? null,
        realMatterAuthority: false,
        productionAuthority: false,
      })),
      contractEvidence: lastStagingEvidence,
      rawPayloadRetained: false,
      realMatterAuthority: false,
      productionAuthority: false,
    });
    return;
  }

  send(res, 404, { error: "NOT_FOUND" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({
    event: "central-legal-agent-isolated-staging-ready",
    port: PORT,
    environment: ENVIRONMENT || "UNSET",
    dataMode: DATA_MODE || "UNSET",
    enabled: ENABLED,
    ready: READY,
    identityMode: "SYNTHETIC_FIXTURE",
    realMatterAuthority: false,
    productionAuthority: false,
  }));
});
