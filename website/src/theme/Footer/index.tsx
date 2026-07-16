import Link from "@docusaurus/Link";
import Translate, { translate } from "@docusaurus/Translate";
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
        <nav
          aria-label={translate({
            id: "footer.navigation",
            message: "Footer navigation",
          })}
          className={styles.links}
        >
          <Link to="/docs/overview">
            <Translate id="footer.documentation">Documentation</Translate>
          </Link>
          <Link to="/docs/architecture">
            <Translate id="footer.architecture">Architecture</Translate>
          </Link>
          <Link to="/docs/operations">
            <Translate id="footer.operations">Operations status</Translate>
          </Link>
          <Link to="/docs/capability-status">
            <Translate id="footer.status">Roadmap and status</Translate>
          </Link>
          <a href={repositoryUrl} rel="noreferrer" target="_blank">
            <Translate id="footer.repository">Source repository</Translate>
          </a>
          <a
            href={`${repositoryUrl}/blob/main/LICENSE`}
            rel="noreferrer"
            target="_blank"
          >
            <Translate id="footer.license">License</Translate>
          </a>
        </nav>
        <p className={styles.copyright}>
          © {new Date().getFullYear()} {siteConfig.title}
        </p>
      </div>
    </footer>
  );
}
