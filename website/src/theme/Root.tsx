import type React from "react";

import LanguageSuggestionBanner from "../components/LanguageSuggestionBanner";

export default function Root({
  children,
}: {
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <>
      {children}
      <LanguageSuggestionBanner />
    </>
  );
}
