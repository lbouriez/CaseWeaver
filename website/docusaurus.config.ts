import type * as Preset from "@docusaurus/preset-classic";
import type { Config } from "@docusaurus/types";
import { themes as prismThemes } from "prism-react-renderer";

const defaultSiteUrl = "https://docs.caseweaver.local";
const repositoryUrl = "https://github.com/lbouriez/CaseWeaver";

function siteUrlFromEnvironment(value: string | undefined): string {
  const url = new URL(value?.trim() || defaultSiteUrl);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "CASEWEAVER_DOCS_SITE_URL must be an HTTPS origin without a path, query, or fragment.",
    );
  }

  return url.origin;
}

function baseUrlFromEnvironment(value: string | undefined): string {
  const normalizedValue = value?.trim();
  if (!normalizedValue) return "/";
  if (!/^\/[A-Za-z0-9/_-]*\/$/u.test(normalizedValue)) {
    throw new Error(
      "CASEWEAVER_DOCS_BASE_URL must start and end with a slash and contain only path segments.",
    );
  }

  return normalizedValue;
}

const config: Config = {
  title: "CaseWeaver",
  tagline: "Evidence-aware case operations, documented carefully.",
  favicon: "img/caseweaver-mark.svg",
  url: siteUrlFromEnvironment(process.env.CASEWEAVER_DOCS_SITE_URL),
  baseUrl: baseUrlFromEnvironment(process.env.CASEWEAVER_DOCS_BASE_URL),
  organizationName: "lbouriez",
  projectName: "CaseWeaver",
  onBrokenLinks: "throw",
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: "throw",
    },
  },
  future: {
    v4: true,
  },
  customFields: {
    repositoryUrl,
  },
  i18n: {
    defaultLocale: "en",
    locales: ["en", "fr"],
    localeConfigs: {
      en: { label: "English", htmlLang: "en-US" },
      fr: { label: "Français", htmlLang: "fr-FR" },
    },
  },
  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          routeBasePath: "docs",
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],
  plugins: [
    [
      require.resolve("@easyops-cn/docusaurus-search-local"),
      {
        hashed: true,
        language: ["en", "fr"],
        indexDocs: true,
        indexBlog: false,
        indexPages: true,
        docsRouteBasePath: "/docs",
        searchBarShortcutHint: false,
        highlightSearchTermsOnTargetPage: true,
      },
    ],
  ],
  themeConfig: {
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
