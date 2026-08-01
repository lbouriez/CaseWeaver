import { useAlternatePageUtils } from "@docusaurus/theme-common/internal";
import Translate, { translate } from "@docusaurus/Translate";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import type React from "react";
import { useEffect, useState } from "react";

import { languageNames, type SupportedLocale } from "../localization/languages";
import {
  dismissLanguageSuggestion,
  languageSuggestionWasDismissed,
  shouldSuggestLocale,
  storeLocalePreference,
  storedLocalePreference,
} from "../localization/language-preference";
import styles from "./LanguageSuggestionBanner.module.css";

export default function LanguageSuggestionBanner(): React.ReactElement | null {
  const { i18n } = useDocusaurusContext();
  const alternatePageUtils = useAlternatePageUtils();
  const currentLocale = i18n.currentLocale as SupportedLocale;
  const [suggestedLocale, setSuggestedLocale] = useState<
    SupportedLocale | undefined
  >();

  useEffect(() => {
    if (typeof window === "undefined") return;
    setSuggestedLocale(
      shouldSuggestLocale({
        currentLocale,
        browserLanguages: navigator.languages,
        dismissed: languageSuggestionWasDismissed(),
        storedLocale: storedLocalePreference(),
      }),
    );
  }, [currentLocale]);

  if (suggestedLocale === undefined) return null;

  const switchLocale = () => {
    storeLocalePreference(suggestedLocale);
    window.location.assign(
      alternatePageUtils.createUrl({
        locale: suggestedLocale,
        fullyQualified: false,
      }),
    );
  };

  const dismiss = () => {
    dismissLanguageSuggestion();
    setSuggestedLocale(undefined);
  };

  return (
    <aside
      aria-label={translate({
        id: "languageSuggestion.label",
        message: "Language suggestion",
      })}
      className={styles.banner}
    >
      <p>
        <Translate
          id="languageSuggestion.message"
          values={{
            current: languageNames[currentLocale],
            suggested: languageNames[suggestedLocale],
          }}
        >
          {
            "Your browser prefers {suggested}. Switch this documentation from {current}?"
          }
        </Translate>
      </p>
      <div className={styles.actions}>
        <button
          className="button button--primary button--sm"
          onClick={switchLocale}
          type="button"
        >
          <Translate
            id="languageSuggestion.switch"
            values={{ suggested: languageNames[suggestedLocale] }}
          >
            {"Switch to {suggested}"}
          </Translate>
        </button>
        <button
          className="button button--secondary button--sm"
          onClick={dismiss}
          type="button"
        >
          <Translate
            id="languageSuggestion.stay"
            values={{ current: languageNames[currentLocale] }}
          >
            {"Stay in {current}"}
          </Translate>
        </button>
      </div>
    </aside>
  );
}
