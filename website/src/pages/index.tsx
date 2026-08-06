import Link from "@docusaurus/Link";
import Translate, { translate } from "@docusaurus/Translate";
import Layout from "@theme/Layout";
import type React from "react";

import { CaseWeaverMark } from "../components/CaseWeaverMark";

function SupportFlowVisual(): React.ReactElement {
  return (
    <div aria-hidden="true" className="homeFlowVisual">
      <div className="homeFlowSource homeFlowSource--knowledge">
        <span className="homeFlowSource__icon">⌘</span>
        <span>
          <Translate id="homepage.visual.knowledge">Knowledge</Translate>
        </span>
      </div>
      <div className="homeFlowSource homeFlowSource--policy">
        <span className="homeFlowSource__icon">✓</span>
        <span>
          <Translate id="homepage.visual.policies">Policies</Translate>
        </span>
      </div>
      <div className="homeFlowSource homeFlowSource--cases">
        <span className="homeFlowSource__icon">↻</span>
        <span>
          <Translate id="homepage.visual.pastCases">Past cases</Translate>
        </span>
      </div>
      <div className="homeFlowLines">
        <span />
        <span />
        <span />
      </div>
      <div className="homeFlowEngine">
        <div className="homeFlowEngine__mark">
          <CaseWeaverMark size={42} title="" />
        </div>
        <span>CaseWeaver</span>
        <small>
          <Translate id="homepage.visual.assembly">evidence assembly</Translate>
        </small>
      </div>
      <div className="homeFlowResult">
        <div className="homeFlowResult__topline">
          <span>
            <Translate id="homepage.visual.case">Case</Translate>
          </span>
          <span className="homeFlowResult__status">
            <Translate id="homepage.visual.ready">Ready</Translate>
          </span>
        </div>
        <strong>
          <Translate id="homepage.visual.nextStep">Clear next step</Translate>
        </strong>
        <p>
          <Translate id="homepage.visual.evidence">
            Sources attached · Confidence explained
          </Translate>
        </p>
      </div>
    </div>
  );
}

export default function HomePage(): React.ReactElement {
  return (
    <Layout
      description={translate({
        id: "homepage.description",
        message:
          "CaseWeaver helps support teams turn company knowledge into evidence-backed case actions.",
      })}
      title={translate({
        id: "homepage.title",
        message: "Case operations, clarified",
      })}
    >
      <main>
        <header className="homeHero">
          <div className="container homeHero__grid">
            <div className="homeHero__copy">
              <p className="homeEyebrow">
                <Translate id="homepage.eyebrow">
                  Evidence-aware support operations
                </Translate>
              </p>
              <h1>
                <Translate id="homepage.headline">
                  Turn every support case into a clear next step.
                </Translate>
              </h1>
              <p className="homeHero__lede">
                <Translate id="homepage.lede">
                  CaseWeaver brings your knowledge, policies, and case history
                  together so teams can investigate quickly, explain the
                  evidence, and act with confidence.
                </Translate>
              </p>
              <div className="homeHero__actions">
                <Link
                  className="button button--primary button--lg"
                  to="/docs/quick-start"
                >
                  <Translate id="homepage.primaryAction">
                    Start locally
                  </Translate>
                </Link>
                <Link
                  className="button button--outline button--lg"
                  to="/docs/operator-console-reference"
                >
                  <Translate id="homepage.secondaryAction">
                    Configure the Console
                  </Translate>
                </Link>
              </div>
              <Link className="homeHero__allGuides" to="/docs/overview">
                <Translate id="homepage.allGuides">
                  Browse all operator and deployment guides
                </Translate>
                <span aria-hidden="true">→</span>
              </Link>
              <ul className="homeHero__proofs">
                <li>
                  <strong>
                    <Translate id="homepage.proof.evidence.title">
                      Evidence, not guesses
                    </Translate>
                  </strong>
                  <span>
                    <Translate id="homepage.proof.evidence.copy">
                      Keep the source behind each recommendation visible.
                    </Translate>
                  </span>
                </li>
                <li>
                  <strong>
                    <Translate id="homepage.proof.boundaries.title">
                      Clear boundaries
                    </Translate>
                  </strong>
                  <span>
                    <Translate id="homepage.proof.boundaries.copy">
                      Secrets, permissions, and costs remain controlled.
                    </Translate>
                  </span>
                </li>
              </ul>
            </div>
            <SupportFlowVisual />
          </div>
        </header>

        <section className="homePaths container">
          <div className="homePaths__heading">
            <p className="homeEyebrow">
              <Translate id="homepage.paths.eyebrow">
                Choose your next step
              </Translate>
            </p>
            <h2>
              <Translate id="homepage.paths.title">
                Start from the job you need to do.
              </Translate>
            </h2>
            <p>
              <Translate id="homepage.paths.copy">
                CaseWeaver is configured in small, governed steps. These guides
                point to the right starting place without exposing credentials
                or guessing at your environment.
              </Translate>
            </p>
          </div>
          <div className="homePaths__grid">
            <Link className="homePathCard" to="/docs/quick-start">
              <span className="homePathCard__number">01</span>
              <h3>
                <Translate id="homepage.paths.local.title">
                  Try CaseWeaver locally
                </Translate>
              </h3>
              <p>
                <Translate id="homepage.paths.local.copy">
                  Run the local stack, open the Console, and see the workflow
                  end to end.
                </Translate>
              </p>
              <span className="homePathCard__link">
                <Translate id="homepage.paths.local.link">
                  Open the quick start
                </Translate>
                <span aria-hidden="true">→</span>
              </span>
            </Link>
            <Link className="homePathCard" to="/docs/operator-knowledge-map">
              <span className="homePathCard__number">02</span>
              <h3>
                <Translate id="homepage.paths.knowledge.title">
                  Connect knowledge safely
                </Translate>
              </h3>
              <p>
                <Translate id="homepage.paths.knowledge.copy">
                  Add trusted sources, organize them into collections, and
                  choose when they are refreshed.
                </Translate>
              </p>
              <span className="homePathCard__link">
                <Translate id="homepage.paths.knowledge.link">
                  Plan a knowledge source
                </Translate>
                <span aria-hidden="true">→</span>
              </span>
            </Link>
            <Link
              className="homePathCard"
              to="/docs/operator-console-reference"
            >
              <span className="homePathCard__number">03</span>
              <h3>
                <Translate id="homepage.paths.console.title">
                  Configure AI and operations
                </Translate>
              </h3>
              <p>
                <Translate id="homepage.paths.console.copy">
                  Configure providers, budgets, analysis, permissions, and audit
                  history from one workspace.
                </Translate>
              </p>
              <span className="homePathCard__link">
                <Translate id="homepage.paths.console.link">
                  Read the Console guide
                </Translate>
                <span aria-hidden="true">→</span>
              </span>
            </Link>
            <Link className="homePathCard" to="/docs/self-hosting">
              <span className="homePathCard__number">04</span>
              <h3>
                <Translate id="homepage.paths.deploy.title">
                  Prepare a real deployment
                </Translate>
              </h3>
              <p>
                <Translate id="homepage.paths.deploy.copy">
                  Keep configuration and secrets separate, then deploy with the
                  supported self-hosting and recovery guides.
                </Translate>
              </p>
              <span className="homePathCard__link">
                <Translate id="homepage.paths.deploy.link">
                  Open the deployment guide
                </Translate>
                <span aria-hidden="true">→</span>
              </span>
            </Link>
          </div>
        </section>

        <section className="homeSection container">
          <div className="homeSection__heading">
            <p className="homeEyebrow">
              <Translate id="homepage.workflow.eyebrow">
                The case flow
              </Translate>
            </p>
            <h2>
              <Translate id="homepage.workflow.title">
                From an incoming request to a response your team can trust.
              </Translate>
            </h2>
          </div>
          <ol className="homeSteps">
            <li>
              <span className="homeSteps__number">01</span>
              <h3>
                <Translate id="homepage.workflow.capture.title">
                  Capture the case
                </Translate>
              </h3>
              <p>
                <Translate id="homepage.workflow.capture.copy">
                  A ticket, schedule, or verified event starts durable work; the
                  platform handles the processing.
                </Translate>
              </p>
            </li>
            <li>
              <span className="homeSteps__number">02</span>
              <h3>
                <Translate id="homepage.workflow.connect.title">
                  Add the context
                </Translate>
              </h3>
              <p>
                <Translate id="homepage.workflow.connect.copy">
                  Approved sources and retrieval profiles surface the relevant
                  knowledge with clear version and ownership boundaries.
                </Translate>
              </p>
            </li>
            <li>
              <span className="homeSteps__number">03</span>
              <h3>
                <Translate id="homepage.workflow.decide.title">
                  Review and respond
                </Translate>
              </h3>
              <p>
                <Translate id="homepage.workflow.decide.copy">
                  Teams get an evidence-backed result they can inspect, approve,
                  and publish through a governed workflow.
                </Translate>
              </p>
            </li>
          </ol>
        </section>

        <section className="homePrinciples">
          <div className="container homePrinciples__grid">
            <div>
              <p className="homeEyebrow">
                <Translate id="homepage.principles.eyebrow">
                  Built to be trusted
                </Translate>
              </p>
              <h2>
                <Translate id="homepage.principles.title">
                  A support system should make decisions easier to explain.
                </Translate>
              </h2>
            </div>
            <div className="homePrinciples__cards">
              <article>
                <span>◌</span>
                <h3>
                  <Translate id="homepage.principles.audit.title">
                    Auditable by design
                  </Translate>
                </h3>
                <p>
                  <Translate id="homepage.principles.audit.copy">
                    Operator actions and configuration changes have explicit
                    server-owned records.
                  </Translate>
                </p>
              </article>
              <article>
                <span>⌁</span>
                <h3>
                  <Translate id="homepage.principles.vendor.title">
                    Vendor-neutral core
                  </Translate>
                </h3>
                <p>
                  <Translate id="homepage.principles.vendor.copy">
                    Connectors and AI providers fit through contracts instead of
                    hard-coded product names.
                  </Translate>
                </p>
              </article>
              <article>
                <span>↗</span>
                <h3>
                  <Translate id="homepage.principles.status.title">
                    Honest capability status
                  </Translate>
                </h3>
                <p>
                  <Translate id="homepage.principles.status.copy">
                    The portal distinguishes what is available today from work
                    still in progress.
                  </Translate>
                </p>
              </article>
            </div>
          </div>
        </section>

        <section className="homeStart container">
          <div>
            <p className="homeEyebrow">
              <Translate id="homepage.start.eyebrow">
                Start with the facts
              </Translate>
            </p>
            <h2>
              <Translate id="homepage.start.title">
                Learn the boundaries before choosing the next delivery step.
              </Translate>
            </h2>
            <p>
              <Translate id="homepage.start.tagline">
                Evidence-aware case operations, documented carefully.
              </Translate>{" "}
              <Translate id="homepage.start.copy">
                Read the architecture, then check the current capability status
                before treating a workflow as supported.
              </Translate>
            </p>
          </div>
          <div className="homeStart__links">
            <Link to="/docs/architecture">
              <Translate id="homepage.start.architecture">
                Architecture orientation
              </Translate>
              <span aria-hidden="true">→</span>
            </Link>
            <Link to="/docs/capability-status">
              <Translate id="homepage.start.status">
                Current capability status
              </Translate>
              <span aria-hidden="true">→</span>
            </Link>
          </div>
        </section>
      </main>
    </Layout>
  );
}
