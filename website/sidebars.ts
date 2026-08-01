import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  documentation: [
    "overview",
    {
      type: "category",
      label: "Get started",
      items: ["quick-start", "access-and-secrets"],
    },
    {
      type: "category",
      label: "Connect knowledge and cases",
      items: ["connectors", "git-markdown", "jitbit", "knowledge-analysis"],
    },
    {
      type: "category",
      label: "AI and governance",
      items: ["ai-and-cost", "configuration-reference"],
    },
    {
      type: "category",
      label: "Operate CaseWeaver",
      items: [
        "self-hosting",
        "persistence-recovery",
        "testing",
        "troubleshooting",
      ],
    },
    {
      type: "category",
      label: "Reference",
      items: ["architecture", "capability-status", "contributing"],
    },
  ],
};

export default sidebars;
