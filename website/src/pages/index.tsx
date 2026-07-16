import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import type React from "react";

export default function HomePage(): React.ReactElement {
  const { siteConfig } = useDocusaurusContext();

  return (
    <Layout
      description="CaseWeaver documentation portal."
      title="Documentation"
    >
      <main>
        <header className="hero">
          <div className="container">
            <p className="hero__subtitle">CaseWeaver documentation</p>
            <h1 className="hero__title">
              Understand what is available before you operate it.
            </h1>
            <p className="hero__subtitle">
              {siteConfig.tagline} This portal starts with the architecture,
              status, and contribution context required for safe documentation
              work.
            </p>
            <div className="hero__buttons">
              <Link
                className="button button--primary button--lg"
                to="/docs/overview"
              >
                Read the overview
              </Link>
              <Link
                className="button button--secondary button--lg"
                to="/docs/capability-status"
              >
                Check capability status
              </Link>
            </div>
          </div>
        </header>
      </main>
    </Layout>
  );
}
