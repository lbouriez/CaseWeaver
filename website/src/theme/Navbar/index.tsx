import Link from "@docusaurus/Link";
import { useLocation } from "@docusaurus/router";
import {
  useAlternatePageUtils,
  useNavbarMobileSidebar,
  useWindowSize,
} from "@docusaurus/theme-common/internal";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import MobileSidebar from "@theme/Navbar/MobileSidebar";
import SearchBar from "@theme/SearchBar";
import clsx from "clsx";
import type React from "react";

import { CaseWeaverMark } from "../../components/CaseWeaverMark";
import {
  isSupportedLocale,
  languageNames,
  supportedLocales,
} from "../../localization/languages";
import styles from "./styles.module.css";

function LocaleChooser(): React.ReactElement {
  const { i18n } = useDocusaurusContext();
  const alternatePageUtils = useAlternatePageUtils();
  const currentLocale = isSupportedLocale(i18n.currentLocale)
    ? i18n.currentLocale
    : "en";

  return (
    <label className={styles.localeLabel}>
      <span className={styles.visuallyHidden}>Select language</span>
      <select
        aria-label="Select language"
        className={styles.localeSelect}
        onChange={(event) => {
          const locale = event.currentTarget.value;
          if (!isSupportedLocale(locale)) return;
          window.location.assign(
            alternatePageUtils.createUrl({
              locale,
              fullyQualified: false,
            }),
          );
        }}
        value={currentLocale}
      >
        {supportedLocales.map((locale) => (
          <option key={locale} value={locale}>
            {languageNames[locale]}
          </option>
        ))}
      </select>
    </label>
  );
}

function NavbarBackdrop({ onClick }: { readonly onClick: () => void }) {
  return (
    <button
      aria-label="Close documentation navigation"
      className="navbar-sidebar__backdrop"
      onClick={onClick}
      type="button"
    />
  );
}

export default function Navbar(): React.ReactElement {
  const { siteConfig } = useDocusaurusContext();
  const location = useLocation();
  const mobileSidebar = useNavbarMobileSidebar();
  const windowSize = useWindowSize();
  const isDocumentationRoute = /(?:^|\/)docs(?:\/|$)/u.test(location.pathname);
  const showMobileNavigation =
    isDocumentationRoute && (windowSize === "mobile" || windowSize === "ssr");
  const repositoryUrl = siteConfig.customFields?.repositoryUrl as string;

  return (
    <nav
      className={clsx("navbar", "navbar--fixed-top", {
        "navbar-sidebar--show": mobileSidebar.shown,
      })}
    >
      <header className={styles.header}>
        <div className={styles.container}>
          <div className={styles.leftSection}>
            {showMobileNavigation ? (
              <button
                aria-expanded={mobileSidebar.shown}
                aria-label="Toggle documentation navigation"
                className={`navbar__toggle clean-btn ${styles.menuButton}`}
                onClick={mobileSidebar.toggle}
                type="button"
              >
                {mobileSidebar.shown ? "Close" : "Menu"}
              </button>
            ) : null}
            <Link className={styles.brand} to="/">
              <CaseWeaverMark />
              <span>{siteConfig.title}</span>
            </Link>
          </div>
          <div className={styles.rightSection}>
            <div className={styles.search}>
              <SearchBar />
            </div>
            <LocaleChooser />
            <a
              className={styles.repositoryLink}
              href={repositoryUrl}
              rel="noreferrer"
              target="_blank"
            >
              Repository
            </a>
          </div>
        </div>
      </header>
      <NavbarBackdrop onClick={mobileSidebar.toggle} />
      <MobileSidebar />
    </nav>
  );
}
