import Link from "@docusaurus/Link";
import Translate, { translate } from "@docusaurus/Translate";
import Layout from "@theme/Layout";
import type React from "react";

import { CaseWeaverMark } from "../components/CaseWeaverMark";

function ArrowIcon(): React.ReactElement {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 18 18">
      <path
        d="M3.25 9h10.5M9.75 5l4 4-4 4"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

function CheckIcon(): React.ReactElement {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16">
      <path
        d="m3.25 8.1 2.9 2.9 6.6-6.35"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function ProductPreview(): React.ReactElement {
  return (
    <div aria-hidden="true" className="homePreview">
      <div className="homePreview__glow" />
      <div className="homePreview__window">
        <div className="homePreview__topbar">
          <div className="homePreview__brand">
            <span className="homePreview__mark">
              <CaseWeaverMark size={18} title="" />
            </span>
            <span>CaseWeaver</span>
          </div>
          <span className="homePreview__state">
            <span />
            <Translate id="homepage.v2.preview.active">
              Analysis ready
            </Translate>
          </span>
        </div>
        <div className="homePreview__body">
          <div className="homePreview__case">
            <span className="homePreview__label">
              <Translate id="homepage.v2.preview.caseLabel">
                Case / 1042
              </Translate>
            </span>
            <strong>
              <Translate id="homepage.v2.preview.caseTitle">
                Customer cannot sign in
              </Translate>
            </strong>
            <p>
              <Translate id="homepage.v2.preview.caseCopy">
                Access fails after a team change.
              </Translate>
            </p>
          </div>
          <div className="homePreview__evidence">
            <span className="homePreview__label">
              <Translate id="homepage.v2.preview.evidenceLabel">
                Supporting evidence
              </Translate>
            </span>
            <div>
              <span className="homePreview__check">
                <CheckIcon />
              </span>
              <span>
                <Translate id="homepage.v2.preview.knowledge">
                  Identity runbook
                </Translate>
              </span>
            </div>
            <div>
              <span className="homePreview__check">
                <CheckIcon />
              </span>
              <span>
                <Translate id="homepage.v2.preview.policy">
                  Access policy
                </Translate>
              </span>
            </div>
          </div>
          <div className="homePreview__answer">
            <span className="homePreview__label">
              <Translate id="homepage.v2.preview.answerLabel">
                Recommended next step
              </Translate>
            </span>
            <strong>
              <Translate id="homepage.v2.preview.answerTitle">
                Restore the verified role, then retry.
              </Translate>
            </strong>
            <span className="homePreview__answerMeta">
              <Translate id="homepage.v2.preview.answerMeta">
                2 sources attached
              </Translate>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

interface FlowCardProps {
  readonly number: string;
  readonly title: React.ReactNode;
  readonly children: React.ReactNode;
}

function FlowCard({
  number,
  title,
  children,
}: FlowCardProps): React.ReactElement {
  return (
    <article className="homeFlowCard">
      <span className="homeFlowCard__number">{number}</span>
      <h3>{title}</h3>
      <p>{children}</p>
    </article>
  );
}

export default function HomePage(): React.ReactElement {
  return (
    <Layout
      description={translate({
        id: "homepage.v2.description",
        message:
          "CaseWeaver turns trusted company knowledge into evidence-backed support actions.",
      })}
      title={translate({
        id: "homepage.v2.title",
        message: "Support answers that hold up",
      })}
    >
      <main className="homePage">
        <section className="homeHero">
          <div className="container homeHero__layout">
            <div className="homeHero__copy">
              <p className="homeKicker">
                <span />
                <Translate id="homepage.v2.kicker">
                  Evidence-aware support operations
                </Translate>
              </p>
              <h1>
                <Translate id="homepage.v2.headline">
                  Support answers that hold up.
                </Translate>
              </h1>
              <p className="homeHero__lede">
                <Translate id="homepage.v2.lede">
                  Connect the knowledge your team trusts. CaseWeaver turns it
                  into a clear next step—with the evidence still attached.
                </Translate>
              </p>
              <div className="homeHero__actions">
                <Link
                  className="homeAction homeAction--primary"
                  to="/docs/quick-start"
                >
                  <Translate id="homepage.v2.primaryAction">
                    Get started
                  </Translate>
                  <ArrowIcon />
                </Link>
                <Link
                  className="homeAction homeAction--quiet"
                  to="/docs/overview"
                >
                  <Translate id="homepage.v2.secondaryAction">
                    Explore the docs
                  </Translate>
                </Link>
              </div>
              <ul className="homeHero__signals">
                <li>
                  <CheckIcon />
                  <Translate id="homepage.v2.signal.evidence">
                    Sources stay visible
                  </Translate>
                </li>
                <li>
                  <CheckIcon />
                  <Translate id="homepage.v2.signal.control">
                    Operators stay in control
                  </Translate>
                </li>
              </ul>
            </div>
            <ProductPreview />
          </div>
        </section>

        <section className="homeFlow container">
          <div className="homeSectionLead">
            <p className="homeKicker">
              <span />
              <Translate id="homepage.v2.flow.kicker">How it works</Translate>
            </p>
            <h2>
              <Translate id="homepage.v2.flow.title">
                One clear operating loop.
              </Translate>
            </h2>
            <p>
              <Translate id="homepage.v2.flow.lede">
                Move from a difficult case to an accountable response without
                losing the context that made it reliable.
              </Translate>
            </p>
          </div>
          <div className="homeFlow__grid">
            <FlowCard
              number="01"
              title={
                <Translate id="homepage.v2.flow.capture.title">
                  Bring in the case
                </Translate>
              }
            >
              <Translate id="homepage.v2.flow.capture.copy">
                Tickets, schedules, and verified events start durable work.
              </Translate>
            </FlowCard>
            <FlowCard
              number="02"
              title={
                <Translate id="homepage.v2.flow.ground.title">
                  Ground the answer
                </Translate>
              }
            >
              <Translate id="homepage.v2.flow.ground.copy">
                Trusted sources and policies supply the context that matters.
              </Translate>
            </FlowCard>
            <FlowCard
              number="03"
              title={
                <Translate id="homepage.v2.flow.act.title">
                  Take the next step
                </Translate>
              }
            >
              <Translate id="homepage.v2.flow.act.copy">
                Review, publish, and audit an answer your team can explain.
              </Translate>
            </FlowCard>
          </div>
        </section>

        <section className="homeRoutes">
          <div className="container">
            <div className="homeSectionLead homeSectionLead--split">
              <div>
                <p className="homeKicker">
                  <span />
                  <Translate id="homepage.v2.routes.kicker">
                    Find your starting point
                  </Translate>
                </p>
                <h2>
                  <Translate id="homepage.v2.routes.title">
                    Start with the work in front of you.
                  </Translate>
                </h2>
              </div>
              <p>
                <Translate id="homepage.v2.routes.lede">
                  Each guide is practical, scoped, and clear about what the
                  platform supports today.
                </Translate>
              </p>
            </div>
            <div className="homeRoutes__grid">
              <Link className="homeRoute" to="/docs/quick-start">
                <span className="homeRoute__eyebrow">
                  <Translate id="homepage.v2.routes.local.label">
                    Local setup
                  </Translate>
                </span>
                <h3>
                  <Translate id="homepage.v2.routes.local.title">
                    Run CaseWeaver locally
                  </Translate>
                </h3>
                <span className="homeRoute__arrow">
                  <ArrowIcon />
                </span>
              </Link>
              <Link className="homeRoute" to="/docs/operator-knowledge-map">
                <span className="homeRoute__eyebrow">
                  <Translate id="homepage.v2.routes.knowledge.label">
                    Knowledge
                  </Translate>
                </span>
                <h3>
                  <Translate id="homepage.v2.routes.knowledge.title">
                    Connect trusted sources
                  </Translate>
                </h3>
                <span className="homeRoute__arrow">
                  <ArrowIcon />
                </span>
              </Link>
              <Link className="homeRoute" to="/docs/operator-console-reference">
                <span className="homeRoute__eyebrow">
                  <Translate id="homepage.v2.routes.console.label">
                    Operations
                  </Translate>
                </span>
                <h3>
                  <Translate id="homepage.v2.routes.console.title">
                    Configure the Console
                  </Translate>
                </h3>
                <span className="homeRoute__arrow">
                  <ArrowIcon />
                </span>
              </Link>
            </div>
          </div>
        </section>

        <section className="homeClose container">
          <div>
            <p className="homeKicker">
              <span />
              <Translate id="homepage.v2.close.kicker">
                Built for accountable work
              </Translate>
            </p>
            <h2>
              <Translate id="homepage.v2.close.title">
                Useful answers need context, controls, and a paper trail.
              </Translate>
            </h2>
          </div>
          <div className="homeClose__actions">
            <Link
              className="homeAction homeAction--dark"
              to="/docs/operator-console-reference"
            >
              <Translate id="homepage.v2.close.console">
                Open the Console guide
              </Translate>
              <ArrowIcon />
            </Link>
            <Link className="homeTextLink" to="/docs/capability-status">
              <Translate id="homepage.v2.close.status">
                See capability status
              </Translate>
              <ArrowIcon />
            </Link>
            <Link className="homeTextLink" to="/docs/self-hosting">
              <Translate id="homepage.v2.close.selfHosting">
                Plan a self-hosted deployment
              </Translate>
              <ArrowIcon />
            </Link>
          </div>
        </section>
      </main>
    </Layout>
  );
}
