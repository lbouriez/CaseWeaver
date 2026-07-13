import { createConnectorConfigurationSchema } from "@caseweaver/connector-sdk";
import { z } from "zod";

export const exampleConnectorSettingsSchema = z
  .object({
    connectorInstanceId: z.string().min(1),
    baseUrl: z.url(),
    projectId: z.string().min(1),
  })
  .strict();

/**
 * Put credentials in `secrets` as references (for example, `vault:example-token`).
 * Do not add plaintext credentials to the settings schema.
 */
export const exampleConnectorConfigurationSchema =
  createConnectorConfigurationSchema(exampleConnectorSettingsSchema);

export type ExampleConnectorSettings = z.infer<
  typeof exampleConnectorSettingsSchema
>;
