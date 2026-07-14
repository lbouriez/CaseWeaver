import { createRoot } from "react-dom/client";

import { OperatorApp } from "./app.js";
import {
  loadRuntimeConfig,
  RuntimeConfigurationError,
} from "./runtime-config.js";

function renderConfigurationFailure(error: unknown) {
  const message =
    error instanceof RuntimeConfigurationError
      ? error.message
      : "The operator console could not load its runtime configuration.";
  createRoot(document.getElementById("root") as HTMLElement).render(
    <main
      aria-labelledby="configuration-title"
      style={{
        alignItems: "center",
        background: "#111312",
        color: "#edf0e9",
        display: "flex",
        fontFamily: '"Bahnschrift", "DIN Alternate", sans-serif',
        minHeight: "100vh",
        padding: "2rem",
      }}
    >
      <section
        role="alert"
        style={{
          border: "1px solid #f0aa3c",
          maxWidth: "44rem",
          padding: "2rem",
        }}
      >
        <p
          style={{
            color: "#f0aa3c",
            fontFamily: "monospace",
            letterSpacing: "0.08em",
          }}
        >
          CONTROL PLANE / CONFIGURATION REQUIRED
        </p>
        <h1
          id="configuration-title"
          style={{
            fontFamily: '"Iowan Old Style", Georgia, serif',
            fontWeight: 500,
          }}
        >
          Console unavailable
        </h1>
        <p>{message}</p>
      </section>
    </main>,
  );
}

void loadRuntimeConfig()
  .then((config) => {
    createRoot(document.getElementById("root") as HTMLElement).render(
      <OperatorApp config={config} />,
    );
  })
  .catch(renderConfigurationFailure);
