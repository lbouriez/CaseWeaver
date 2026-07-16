import {
  Box,
  Button,
  IconButton,
  Popover,
  Stack,
  Typography,
} from "@mui/material";
import { useId, useState } from "react";

export interface DescriptorFieldHelpExample {
  /** Safe form value applied only after the operator explicitly chooses it. */
  readonly value: string;
  /** Human-language explanation shown in the popover instead of syntax. */
  readonly label: string;
}

/**
 * Safe descriptor metadata is the sole source of form help. The component
 * deliberately has no access to configuration history, secret registrations,
 * or adapter details.
 */
export function DescriptorFieldHelp({
  label,
  description,
  examples = [],
  onUseExample,
}: {
  readonly label: string;
  readonly description?: string;
  readonly examples?: readonly (DescriptorFieldHelpExample | string)[];
  readonly onUseExample?: (example: string) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement>();
  const popoverId = useId();
  const displayExamples = examples.map((example) =>
    typeof example === "string" ? { value: example, label: example } : example,
  );
  if (description === undefined && examples.length === 0) return null;
  const open = anchor !== undefined;
  const id = open ? popoverId : undefined;
  return (
    <Box>
      <IconButton
        aria-describedby={id}
        aria-label={`Help for ${label}`}
        onClick={(event) => setAnchor(event.currentTarget)}
        size="small"
        sx={{
          border: "1px solid",
          borderColor: "divider",
          fontSize: "0.75rem",
          height: 22,
          width: 22,
        }}
        type="button"
      >
        i
      </IconButton>
      <Popover
        anchorEl={anchor}
        anchorOrigin={{ horizontal: "left", vertical: "bottom" }}
        id={id}
        onClose={() => setAnchor(undefined)}
        open={open}
      >
        <Stack spacing={1} sx={{ maxWidth: 520, p: 2 }}>
          {description === undefined ? null : (
            <Typography variant="body2">{description}</Typography>
          )}
          {displayExamples.length === 0 ? null : (
            <>
              <Typography variant="subtitle2">Examples</Typography>
              {displayExamples.map((example, index) => (
                <Stack key={example.value} direction="row" spacing={1}>
                  <Typography
                    sx={{ overflowWrap: "anywhere", flex: 1 }}
                    variant="body2"
                  >
                    {example.label}
                  </Typography>
                  {onUseExample === undefined ? null : (
                    <Button
                      onClick={() => {
                        onUseExample(example.value);
                        setAnchor(undefined);
                      }}
                      size="small"
                      type="button"
                    >
                      Use example {index + 1}
                    </Button>
                  )}
                </Stack>
              ))}
            </>
          )}
        </Stack>
      </Popover>
    </Box>
  );
}
