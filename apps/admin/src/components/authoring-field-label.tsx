import { Stack, Typography } from "@mui/material";

import { DescriptorFieldHelp } from "./descriptor-field-help.js";

/**
 * A consistent accessible heading for a configuration decision. The underlying
 * control remains independently labelled; this adjacent heading only adds
 * optional, safe explanatory metadata without introducing a second data
 * boundary or a capability-specific UI branch.
 */
export function AuthoringFieldLabel({
  label,
  description,
  examples,
}: {
  readonly label: string;
  readonly description: string;
  readonly examples?: readonly string[];
}) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
      <Typography variant="subtitle2">{label}</Typography>
      <DescriptorFieldHelp
        description={description}
        examples={examples}
        label={label}
      />
    </Stack>
  );
}
