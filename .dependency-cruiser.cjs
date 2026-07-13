module.exports = {
  forbidden: [
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
