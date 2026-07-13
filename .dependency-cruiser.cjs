module.exports = {
  forbidden: [
    {
      name: "features-do-not-import-providers",
      comment:
        "Feature packages must call the metered AI execution gateway, never provider adapters.",
      severity: "error",
      from: {
        path: "^packages/",
      },
      to: {
        path: "^providers/",
      },
    },
    {
      name: "providers-do-not-import-ai-policy",
      comment:
        "Provider adapters translate requests only; configuration and execution policy stay inward.",
      severity: "error",
      from: {
        path: "^providers/",
      },
      to: {
        path: "^packages/(ai-config|ai-execution)/",
      },
    },
    {
      name: "no-circular",
      comment:
        "Circular dependencies make module initialization and ownership unclear.",
      severity: "error",
      from: {},
      to: {
        circular: true,
      },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    exclude: {
      path: "(^|/)(dist|coverage)(/|$)",
    },
  },
};
