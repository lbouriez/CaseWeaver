import type { RenderedPublication } from "@caseweaver/connector-sdk";
import {
  type CaseAnalysisOutput,
  caseAnalysisOutputSchema,
} from "@caseweaver/prompts";

import type { PublicationRenderer } from "./ports.js";
import {
  type PublicationProfile,
  publicationProfileSchema,
} from "./profiles.js";

export class PublicationRenderingError extends Error {
  public readonly retryable = false;

  public constructor(
    public readonly code:
      | "publication.bodyLimitExceeded"
      | "publication.unsupportedVisibility",
    message: string,
  ) {
    super(message);
    this.name = "PublicationRenderingError";
  }
}

interface RenderSections {
  readonly summary: string;
  readonly probableCauses: readonly string[];
  readonly investigation: readonly string[];
  readonly recommendedActions: readonly string[];
  readonly unansweredQuestions: readonly string[];
  readonly confidence: string;
}

function sections(analysis: CaseAnalysisOutput): RenderSections {
  return {
    summary: analysis.summary,
    probableCauses: analysis.probableCauses.map((cause) => cause.statement),
    investigation: analysis.investigation.map((step) => step.step),
    recommendedActions: analysis.recommendedActions.map(
      (action) => action.statement,
    ),
    unansweredQuestions: analysis.unansweredQuestions,
    confidence: analysis.confidence,
  };
}

function list(values: readonly string[], prefix: string): string {
  return values.map((value) => `${prefix}${value}`).join("\n");
}

function plainTextBody(content: RenderSections): string {
  const blocks = [
    `Analysis summary\n${content.summary}`,
    `Confidence\n${content.confidence}`,
    ...(content.probableCauses.length === 0
      ? []
      : [`Probable causes\n${list(content.probableCauses, "- ")}`]),
    ...(content.investigation.length === 0
      ? []
      : [`Investigation\n${list(content.investigation, "- ")}`]),
    ...(content.recommendedActions.length === 0
      ? []
      : [`Recommended actions\n${list(content.recommendedActions, "- ")}`]),
    ...(content.unansweredQuestions.length === 0
      ? []
      : [`Unanswered questions\n${list(content.unansweredQuestions, "- ")}`]),
  ];
  return blocks.join("\n\n");
}

function markdownBody(content: RenderSections): string {
  const blocks = [
    `## Analysis summary\n\n${content.summary}`,
    `## Confidence\n\n${content.confidence}`,
    ...(content.probableCauses.length === 0
      ? []
      : [`## Probable causes\n\n${list(content.probableCauses, "- ")}`]),
    ...(content.investigation.length === 0
      ? []
      : [`## Investigation\n\n${list(content.investigation, "- ")}`]),
    ...(content.recommendedActions.length === 0
      ? []
      : [
          `## Recommended actions\n\n${list(content.recommendedActions, "- ")}`,
        ]),
    ...(content.unansweredQuestions.length === 0
      ? []
      : [
          `## Unanswered questions\n\n${list(
            content.unansweredQuestions,
            "- ",
          )}`,
        ]),
  ];
  return blocks.join("\n\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlList(values: readonly string[]): string {
  return `<ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>`;
}

function htmlBody(content: RenderSections): string {
  const blocks = [
    `<h2>Analysis summary</h2><p>${escapeHtml(content.summary)}</p>`,
    `<h2>Confidence</h2><p>${escapeHtml(content.confidence)}</p>`,
    ...(content.probableCauses.length === 0
      ? []
      : [`<h2>Probable causes</h2>${htmlList(content.probableCauses)}`]),
    ...(content.investigation.length === 0
      ? []
      : [`<h2>Investigation</h2>${htmlList(content.investigation)}`]),
    ...(content.recommendedActions.length === 0
      ? []
      : [
          `<h2>Recommended actions</h2>${htmlList(content.recommendedActions)}`,
        ]),
    ...(content.unansweredQuestions.length === 0
      ? []
      : [
          `<h2>Unanswered questions</h2>${htmlList(
            content.unansweredQuestions,
          )}`,
        ]),
  ];
  return blocks.join("");
}

function appendNotices(body: string, profile: PublicationProfile): string {
  const notices = [
    ...(profile.notices.aiDisclosure === undefined
      ? []
      : [profile.notices.aiDisclosure]),
    ...profile.notices.disclaimers,
  ];
  if (notices.length === 0) return body;

  if (profile.renderer.format === "html") {
    return `${body}<hr><p>${notices.map(escapeHtml).join("<br>")}</p>`;
  }
  return `${body}\n\n${notices.join("\n")}`;
}

export class StructuredAnalysisPublicationRenderer
  implements PublicationRenderer
{
  public render(input: {
    readonly analysis: CaseAnalysisOutput;
    readonly profile: PublicationProfile;
  }): RenderedPublication {
    const profile = publicationProfileSchema.parse(input.profile);
    const analysis = caseAnalysisOutputSchema.parse(input.analysis);
    if (profile.policy.visibility !== "internal") {
      throw new PublicationRenderingError(
        "publication.unsupportedVisibility",
        "Customer-visible publication is not available.",
      );
    }

    const content = sections(analysis);
    const initialBody =
      profile.renderer.format === "plainText"
        ? plainTextBody(content)
        : profile.renderer.format === "markdown"
          ? markdownBody(content)
          : htmlBody(content);
    const body = appendNotices(initialBody, profile);
    if (body.length > profile.limits.maximumBodyCharacters) {
      throw new PublicationRenderingError(
        "publication.bodyLimitExceeded",
        "Rendered publication exceeds the destination body limit.",
      );
    }
    return Object.freeze({
      format: profile.renderer.format,
      body,
      visibility: profile.policy.visibility,
    });
  }
}
