import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import type React from "react";

import { CaseWeaverMark } from "../../components/CaseWeaverMark";
import styles from "./styles.module.css";

export default function Footer(): React.ReactElement {
  const { siteConfig } = useDocusaurusContext();
  const repositoryUrl = siteConfig.customFields?.repositoryUrl as string;

  return (
    <footer className={styles.footer}>
      <div className={styles.container}>
        <Link className={styles.brand} to="/">
          <CaseWeaverMark />
          <span>{siteConfig.title}</span>
        </Link>
        <nav aria-label="Footer navigation" className={styles.links}>
          <Link to="/docs/overview">Documentation</Link>
          <Link to="/docs/architecture">Architecture</Link>
          <Link to="/docs/operations">Operations status</Link>
          <Link to="/docs/capability-status">Roadmap and status</Link>
          <a href={repositoryUrl} rel="noreferrer" target="_blank">
            Source repository
          </a>
          <a
            href={`${repositoryUrl}/blob/main/LICENSE`}
            rel="noreferrer"
            target="_blank"
          >
            License
          </a>
        </nav>
        <p className={styles.copyright}>
          © {new Date().getFullYear()} {siteConfig.title}
        </p>
      </div>
    </footer>
  );
}
