import {
  createDiagnosticEvent,
  type DiagnosticEvent,
  type DiagnosticEventInput,
  type DiagnosticExportSource,
  type DiagnosticSink,
} from "./diagnostics.js";

/**
 * Test-only diagnostic capture. It records the same redacted event contract as
 * production sinks and is intentionally not a telemetry SDK substitute.
 */
export class InMemoryDiagnosticSink
  implements DiagnosticSink, DiagnosticExportSource
{
  private readonly events: DiagnosticEvent[] = [];

  public record(event: DiagnosticEvent): void {
    this.events.push(
      createDiagnosticEvent({
        name: event.name,
        occurredAt: new Date(event.occurredAt),
        severity: event.severity,
        attributes: event.attributes,
      }),
    );
  }

  public recordInput(input: DiagnosticEventInput): void {
    this.record(createDiagnosticEvent(input));
  }

  public snapshot(): readonly DiagnosticEvent[] {
    return Object.freeze([...this.events]);
  }
}
